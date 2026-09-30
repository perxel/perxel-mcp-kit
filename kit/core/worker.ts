import {
  CLIENT_INFO_META_KEY,
  McpServer,
  createMcpHandler,
  isLegacyRequest,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import { callerKeyFor } from "./caller.js";
import { clientFamily } from "./caller.js";
import type { McpConfig } from "./config.js";
import { renderDocsPage } from "./docs-page.js";
import type { Env } from "./env.js";
import { checkRateLimit } from "./rate-limit.js";
import { recordToolCall, type MetricStatus } from "./metrics.js";
import { ToolError, type ToolContext } from "./tool.js";
import { KIT_VERSION } from "./version.js";

export interface ToolFinish {
  tool: string;
  status: Extract<MetricStatus, "ok" | "error" | "invalid_input">;
  code: string;
  count: number;
}

function toToolAuth(authInfo: AuthInfo | undefined): ToolContext["auth"] {
  if (!authInfo) return null;
  const extra = (authInfo.extra ?? {}) as Record<string, unknown>;
  const userId = typeof extra.userId === "string" ? extra.userId : (authInfo.clientId ?? "unknown");
  const email = typeof extra.email === "string" ? extra.email : undefined;
  return { userId, email, scopes: authInfo.scopes ?? [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Builds the per-request McpServer from the clone config (a fresh server per request: stateless). */
export function buildServer(
  config: McpConfig,
  toolCtx: ToolContext,
  hooks?: { onFinish?: (finish: ToolFinish) => void },
): McpServer {
  const server = new McpServer(
    { name: config.slug, version: config.version },
    { cacheHints: { "tools/list": { ttlMs: 300_000, cacheScope: "public" } } },
  );
  for (const def of config.tools) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.inputSchema,
        ...(def.outputSchema ? { outputSchema: def.outputSchema } : {}),
        annotations: { readOnlyHint: true, ...def.annotations },
      },
      async (args) => {
        try {
          const result = await def.execute(args, toolCtx);
          hooks?.onFinish?.({ tool: def.name, status: "ok", code: "", count: result.count ?? -1 });
          const text = JSON.stringify(result.data);
          // structuredContent must be an object on the wire; anything else goes out as text only.
          return isRecord(result.data)
            ? { content: [{ type: "text" as const, text }], structuredContent: result.data }
            : { content: [{ type: "text" as const, text }] };
        } catch (err) {
          if (err instanceof ToolError) {
            const status = err.code === "bad_input" ? "invalid_input" as const : "error" as const;
            hooks?.onFinish?.({ tool: def.name, status, code: err.code, count: -1 });
            return { content: [{ type: "text" as const, text: err.message }], isError: true };
          }
          toolCtx.log("tool.internal_error", { tool: def.name, stack: err instanceof Error ? err.stack : String(err) });
          hooks?.onFinish?.({ tool: def.name, status: "error", code: "internal", count: -1 });
          return { content: [{ type: "text" as const, text: "Internal error" }], isError: true };
        }
      },
    );
  }
  return server;
}

function json(status: number, body: unknown, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers });
}

/** One JSON-RPC message's tools/call, if it is one. */
function findToolCalls(body: unknown): { name: string; id: unknown }[] {
  const msgs = Array.isArray(body) ? body : [body];
  const out: { name: string; id: unknown }[] = [];
  for (const m of msgs) {
    if (!isRecord(m) || m["method"] !== "tools/call" || !isRecord(m["params"])) continue;
    if (typeof m["params"]["name"] !== "string") continue;
    out.push({ name: m["params"]["name"] as string, id: (m["id"] ?? null) as unknown });
  }
  return out;
}

/** The 2026 client identity (`clientInfo.name`) from the first message that carries it. */
function clientInfoName(body: unknown): string | undefined {
  const msgs = Array.isArray(body) ? body : [body];
  for (const m of msgs) {
    if (!isRecord(m) || !isRecord(m["params"]) || !isRecord(m["params"]["_meta"])) continue;
    const info = (m["params"]["_meta"] as Record<string, unknown>)[CLIENT_INFO_META_KEY];
    if (isRecord(info) && typeof info["name"] === "string") return info["name"] as string;
  }
  return undefined;
}

/** Source status for /health (phase 2 passes real static-source statuses here). */
export interface SourceStatus {
  from: "memory" | "fetch" | "kv-fallback" | "empty";
  fetchedAt: string;
  etag: string;
  items: number;
}

export interface WorkerOptions {
  sources?: Record<string, SourceStatus>;
}

/**
 * The kit entry: `export default createWorker(config)` in the clone's `src/index.ts`.
 * Phase 1: public tools only (no token yet); OAuth routes answer 501 until phase 3.
 */
export function createWorker(config: McpConfig, opts?: WorkerOptions) {
  async function fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const requestId = crypto.randomUUID();
    const log = (event: string, fields?: Record<string, unknown>) =>
      console.log(JSON.stringify({ requestId, event, ...fields }));

    if (path === "/mcp") {
      const t0 = Date.now();
      const ip = request.headers.get("CF-Connecting-IP") ?? undefined;

      // Rate limit before the gate. Missing binding (tests, local) means allow.
      const decision = await checkRateLimit(env, ip).catch(() => ({
        allowed: true as boolean,
        callerKey: null as string | null,
        anthropicCloud: false,
      }));
      let body: unknown = null;
      if (request.method === "POST") {
        try {
          body = await request.clone().json();
        } catch {
          body = null;
        }
      }
      const calls = request.method === "POST" ? findToolCalls(body) : [];
      const firstId = calls.length > 0 ? calls[0].id : null;

      if (!decision.allowed) {
        const res = json(429, {
          jsonrpc: "2.0",
          id: firstId,
          error: { code: -32000, message: "Rate limit exceeded, retry in a minute" },
        }, { "Retry-After": "60" });
        const bytes = new TextEncoder().encode(await res.clone().text()).length;
        const latencyMs = Date.now() - t0;
        ctx.waitUntil(
          (async () => {
            for (const call of calls) {
              const tool = config.tools.find((t) => t.name === call.name);
              recordToolCall(env, {
                callerKey: decision.callerKey ?? "",
                slug: config.slug,
                tool: tool ? tool.name : "unknown",
                status: "rate_limited",
                code: "",
                client: clientFamily(ip, clientInfoName(body), request.headers.get("user-agent") ?? undefined),
                access: tool ? tool.access : "public",
                auth: "anon",
                country: (request as unknown as { cf?: { country?: string } }).cf?.country ?? "",
                era: "legacy",
                latencyMs,
                count: -1,
                bytes,
              });
            }
          })(),
        );
        log("request", { route: "mcp", method: request.method, status: 429, latencyMs });
        return res;
      }

      const era = (await isLegacyRequest(request).catch(() => true)) ? "legacy" as const : "modern" as const;
      const finishes: ToolFinish[] = [];
      const perRequest = createMcpHandler(
        (reqCtx) => {
          const toolCtx: ToolContext = {
            env,
            auth: toToolAuth(reqCtx.authInfo),
            requestId,
            log,
          };
          return buildServer(config, toolCtx, { onFinish: (f) => finishes.push(f) });
        },
        { legacy: "stateless" },
      );
      const res = await perRequest.fetch(request);
      const bytes = await res
        .clone()
        .text()
        .then((t) => new TextEncoder().encode(t).length)
        .catch(() => -1);
      const latencyMs = Date.now() - t0;

      if (calls.length > 0) {
        const name = clientInfoName(body);
        const ua = request.headers.get("user-agent") ?? undefined;
        const country = (request as unknown as { cf?: { country?: string } }).cf?.country ?? "";
        const callerKey = await callerKeyFor(env.IP_HASH_SALT, null, ip).catch(() => "");
        const remaining = [...finishes];
        ctx.waitUntil(
          (async () => {
            for (const call of calls) {
              const tool = config.tools.find((t) => t.name === call.name);
              const idx = remaining.findIndex((f) => f.tool === call.name);
              const finish = idx >= 0 ? remaining.splice(idx, 1)[0] : undefined;
              recordToolCall(env, {
                callerKey,
                slug: config.slug,
                tool: tool ? tool.name : "unknown",
                // The SDK answers isError without running execute on a schema
                // failure (invalid_input) or an unknown tool (error).
                status: finish ? finish.status : tool ? "invalid_input" : "error",
                code: finish ? finish.code : tool ? "invalid_params" : "method_not_found",
                client: clientFamily(ip, name, ua),
                access: tool ? tool.access : "public",
                auth: "anon",
                country,
                era,
                latencyMs,
                count: finish ? finish.count : -1,
                bytes,
              });
            }
          })(),
        );
      }
      log("request", { route: "mcp", method: request.method, status: res.status, latencyMs, era });
      return res;
    }

    if (path === "/health" && request.method === "GET") {
      const sources = opts?.sources ?? {};
      const empty = Object.values(sources).some((s) => s.from === "empty");
      return json(empty ? 503 : 200, {
        ok: !empty,
        name: config.name,
        slug: config.slug,
        version: config.version,
        kit: KIT_VERSION,
        sources,
      });
    }

    if (path === "/" && request.method === "GET") {
      const publicUrl = (env.MCP_PUBLIC_URL as string | undefined) ?? `http://${url.host}`;
      return new Response(renderDocsPage(config, publicUrl), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (
      path === "/.well-known/oauth-protected-resource" ||
      path === "/.well-known/oauth-protected-resource/mcp" ||
      path === "/.well-known/oauth-authorization-server" ||
      path === "/authorize" ||
      path === "/token" ||
      path === "/register" ||
      path === "/callback"
    ) {
      return json(501, { error: "not_implemented", message: "OAuth lands in phase 3" });
    }

    return json(404, { error: "not_found" });
  }

  return { fetch };
}
