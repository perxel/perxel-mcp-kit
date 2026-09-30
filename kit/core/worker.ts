import {
  CLIENT_INFO_META_KEY,
  McpServer,
  createMcpHandler,
  isLegacyRequest,
} from "@modelcontextprotocol/server";
import {
  getOAuthApi,
  insufficientScope,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { callerKeyFor, clientFamily } from "./caller.js";
import { handleAuthorizeGet, handleAuthorizePost, handleCallback } from "./access.js";
import type { McpConfig } from "./config.js";
import { dashPathFor, handleDash, isDashPath } from "./dash.js";
import { renderDocsPage } from "./docs-page.js";
import type { Env } from "./env.js";
import {
  buildProvider,
  gateCallsFromBody,
  gateCallsFromHeaders,
  missingScopesFor,
  needsAuthFor,
  privateScopesFor,
  providerOptionsFor,
  resourceMetadataDoc,
  unauthorizedResponse,
  type GateCall,
} from "./oauth.js";
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

/** A live source for /health: loaded (from memory, fetch or KV) on each check, then reported. */
export interface HealthSource {
  get(env: Env, ctx?: ExecutionContext): Promise<unknown>;
  status(): SourceStatus;
}

export interface WorkerOptions {
  /** Sources reported by /health: a `createStaticSource` result (live) or a fixed status. */
  sources?: Record<string, SourceStatus | HealthSource>;
}

async function sourceStatuses(
  sources: Record<string, SourceStatus | HealthSource>,
  env: Env,
  ctx: ExecutionContext,
): Promise<Record<string, SourceStatus>> {
  const out: Record<string, SourceStatus> = {};
  await Promise.all(
    Object.entries(sources).map(async ([name, src]) => {
      if ("status" in src && typeof src.status === "function") {
        // Load first so a fresh isolate reports what a tool call would get,
        // not "empty"; a failed load shows up as the status it leaves behind.
        await src.get(env, ctx).catch(() => undefined);
        out[name] = src.status();
      } else {
        out[name] = src as SourceStatus;
      }
    }),
  );
  return out;
}

type Era = "legacy" | "modern";

interface McpServeOpts {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  config: McpConfig;
  requestId: string;
  log: (event: string, fields?: Record<string, unknown>) => void;
  t0: number;
  ip: string | undefined;
  body: unknown;
  era: Era;
  /** The verified identity (null for anonymous public calls). */
  toolAuth: ToolContext["auth"];
  metricAuth: "anon" | "user";
  userId: string | null;
}

interface ReqFacts {
  client: ReturnType<typeof clientFamily>;
  country: string;
  callerKey: string;
}

async function reqFacts(
  env: Env,
  request: Request,
  body: unknown,
  ip: string | undefined,
  userId: string | null,
): Promise<ReqFacts> {
  return {
    client: clientFamily(ip, clientInfoName(body), request.headers.get("user-agent") ?? undefined),
    country: (request as unknown as { cf?: { country?: string } }).cf?.country ?? "",
    callerKey: await callerKeyFor(env.IP_HASH_SALT, userId, ip).catch(() => ""),
  };
}

/**
 * Serve one /mcp request through the SDK (stateless) and record one metrics
 * row per `tools/call`. The caller has already passed the gate; `toolAuth`
 * carries the verified identity (or null).
 */
async function serveMcp(opts: McpServeOpts): Promise<Response> {
  const { request, env, ctx, config, requestId, log, t0, ip, body, era, toolAuth, metricAuth, userId } = opts;
  const calls = gateCallsFromBody(body);
  const finishes: ToolFinish[] = [];
  const perRequest = createMcpHandler(
    () => {
      const toolCtx: ToolContext = { env, auth: toolAuth, requestId, log };
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
    const facts = await reqFacts(env, request, body, ip, userId);
    const remaining = [...finishes];
    ctx.waitUntil(
      (async () => {
        for (const call of calls) {
          const tool = config.tools.find((t) => t.name === call.name);
          const idx = remaining.findIndex((f) => f.tool === call.name);
          const finish = idx >= 0 ? remaining.splice(idx, 1)[0] : undefined;
          recordToolCall(env, {
            callerKey: facts.callerKey,
            slug: config.slug,
            tool: tool ? tool.name : "unknown",
            // The SDK answers isError without running execute on a schema
            // failure (invalid_input) or an unknown tool (error).
            status: finish ? finish.status : tool ? "invalid_input" : "error",
            code: finish ? finish.code : tool ? "invalid_params" : "method_not_found",
            client: facts.client,
            access: tool ? tool.access : "public",
            auth: metricAuth,
            country: facts.country,
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

/** The provider-validated identity the apiHandler sees (subset of OAuthResourceAuth we rely on). */
interface ValidatedIdentity {
  token: string;
  audience: string;
  scope: string[];
  userId?: string;
  clientId?: string;
}

/**
 * The kit entry: `export default createWorker(config)` in the clone's `src/index.ts`.
 * One-Worker OAuth shape (task 3.5): the gate answers 401 itself for private
 * calls without a token; anything carrying a token goes through the provider.
 */
export function createWorker(config: McpConfig, opts?: WorkerOptions) {
  async function fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const requestId = crypto.randomUUID();
    const log = (event: string, fields?: Record<string, unknown>) =>
      console.log(JSON.stringify({ requestId, event, ...fields }));
    const publicUrl = (env.MCP_PUBLIC_URL as string | undefined) ?? `http://${url.host}`;

    // The provider needs the handlers before it exists; the default handler
    // resolves the OAuth helpers lazily from the same options object.
    const apiHandler = {
      fetch: async (req: Request, e: Env, c: ExecutionContext): Promise<Response> => {
        const t0 = Date.now();
        const raw = c as ExecutionContext & { props?: { userId?: string; email?: string | null }; auth?: ValidatedIdentity };
        const granted = raw.auth?.scope ?? [];
        let body: unknown = null;
        if (req.method === "POST") {
          try {
            body = await req.clone().json();
          } catch {
            body = null;
          }
        }
        const calls = gateCallsFromBody(body);
        const names = calls.map((call) => call.name);
        const missing = missingScopesFor(config, names, granted);
        const ip = req.headers.get("CF-Connecting-IP") ?? undefined;
        const userId = raw.auth?.userId ?? raw.props?.userId ?? null;
        if (missing.length > 0) {
          const res = insufficientScope(
            raw.auth as Parameters<typeof insufficientScope>[0],
            missing,
          );
          const bytes = await res
            .clone()
            .text()
            .then((t) => new TextEncoder().encode(t).length)
            .catch(() => -1);
          const facts = await reqFacts(e, req, body, ip, userId);
          const era = await isLegacyRequest(req)
            .then((legacy) => (legacy ? ("legacy" as const) : ("modern" as const)))
            .catch(() => "legacy" as const);
          c.waitUntil(
            (async () => {
              for (const call of calls) {
                const tool = config.tools.find((t) => t.name === call.name);
                recordToolCall(e, {
                  callerKey: facts.callerKey,
                  slug: config.slug,
                  tool: tool ? tool.name : "unknown",
                  status: "forbidden",
                  code: "insufficient_scope",
                  client: facts.client,
                  access: tool ? tool.access : "public",
                  auth: "user",
                  country: facts.country,
                  era,
                  latencyMs: Date.now() - t0,
                  count: -1,
                  bytes,
                });
              }
            })(),
          );
          return res;
        }
        const email = raw.props?.email ?? undefined;
        return serveMcp({
          request: req,
          env: e,
          ctx: c,
          config,
          requestId,
          log,
          t0,
          ip,
          body,
          era: await isLegacyRequest(req)
            .then((legacy) => (legacy ? ("legacy" as const) : ("modern" as const)))
            .catch(() => "legacy" as const),
          toolAuth: userId
            ? { userId, ...(email ? { email } : {}), scopes: granted }
            : { userId: "unknown", scopes: granted },
          metricAuth: "user",
          userId,
        });
      },
    };
    const defaultHandler = {
      fetch: async (req: Request, e: Env, _c: ExecutionContext): Promise<Response> => {
        const api: OAuthHelpers = getOAuthApi(providerOpts, e);
        const p = new URL(req.url).pathname;
        if (p === "/authorize" && req.method === "GET") return handleAuthorizeGet(req, e, api, config);
        if (p === "/authorize" && req.method === "POST") return handleAuthorizePost(req, e, api, config);
        if (p === "/callback" && req.method === "GET") return handleCallback(req, e, api, config);
        return json(404, { error: "not_found" });
      },
    };
    const providerOpts = providerOptionsFor(config, publicUrl, { apiHandler, defaultHandler });

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
      // Body parse wins; the 2026 headers are the fallback (e.g. a tools/list
      // body carrying a tools/call header never happens, but be liberal).
      const bodyCalls = request.method === "POST" ? gateCallsFromBody(body) : [];
      const calls: GateCall[] = bodyCalls.length > 0 ? bodyCalls : gateCallsFromHeaders(request);
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
            const facts = await reqFacts(env, request, body, ip, null);
            for (const call of calls) {
              const tool = config.tools.find((t) => t.name === call.name);
              recordToolCall(env, {
                callerKey: decision.callerKey ?? "",
                slug: config.slug,
                tool: tool ? tool.name : "unknown",
                status: "rate_limited",
                code: "",
                client: facts.client,
                access: tool ? tool.access : "public",
                auth: "anon",
                country: facts.country,
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

      const era = await isLegacyRequest(request).catch(() => true) ? ("legacy" as const) : ("modern" as const);
      const names = calls.map((call) => call.name);
      const authHeader = request.headers.get("Authorization");
      const needsAuth = needsAuthFor(config, names);

      // Public call, no token: straight to the SDK, no identity.
      if (!authHeader && !needsAuth) {
        return serveMcp({
          request, env, ctx, config, requestId, log, t0, ip, body, era,
          toolAuth: null, metricAuth: "anon", userId: null,
        });
      }

      // Private call, no token: the real 401 that makes Claude show Connect.
      if (!authHeader && needsAuth) {
        const res = unauthorizedResponse(publicUrl, privateScopesFor(config, names));
        const bytes = new TextEncoder().encode(await res.clone().text()).length;
        const latencyMs = Date.now() - t0;
        ctx.waitUntil(
          (async () => {
            const facts = await reqFacts(env, request, body, ip, null);
            for (const call of calls) {
              const tool = config.tools.find((t) => t.name === call.name);
              recordToolCall(env, {
                callerKey: facts.callerKey,
                slug: config.slug,
                tool: tool ? tool.name : "unknown",
                status: "unauthorized",
                code: "",
                client: facts.client,
                access: tool ? tool.access : "public",
                auth: "anon",
                country: facts.country,
                era,
                latencyMs,
                count: -1,
                bytes,
              });
            }
          })(),
        );
        log("request", { route: "mcp", method: request.method, status: 401, latencyMs });
        return res;
      }

      // A token is present (or a public call chose to send one): the provider
      // validates it and routes to the apiHandler above, or answers 401
      // itself for a dead/unknown token.
      const res = await buildProvider(providerOpts).fetch(request, env, ctx);
      if (res.status === 401 && calls.length > 0) {
        const bytes = await res
          .clone()
          .text()
          .then((t) => new TextEncoder().encode(t).length)
          .catch(() => -1);
        const latencyMs = Date.now() - t0;
        ctx.waitUntil(
          (async () => {
            const facts = await reqFacts(env, request, body, ip, null);
            for (const call of calls) {
              const tool = config.tools.find((t) => t.name === call.name);
              recordToolCall(env, {
                callerKey: facts.callerKey,
                slug: config.slug,
                tool: tool ? tool.name : "unknown",
                status: "unauthorized",
                code: "invalid_token",
                client: facts.client,
                access: tool ? tool.access : "public",
                auth: "anon",
                country: facts.country,
                era,
                latencyMs,
                count: -1,
                bytes,
              });
            }
          })(),
        );
      }
      log("request", { route: "mcp", method: request.method, status: res.status, latencyMs: Date.now() - t0, era });
      return res;
    }

    if (path === "/health" && request.method === "GET") {
      const sources = await sourceStatuses(opts?.sources ?? {}, env, ctx);
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
      return new Response(renderDocsPage(config, publicUrl), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (
      path === "/.well-known/oauth-protected-resource" ||
      path === "/.well-known/oauth-protected-resource/mcp"
    ) {
      return Response.json(resourceMetadataDoc(publicUrl), {
        headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
      });
    }

    const dashPath = dashPathFor(env);
    if (dashPath && isDashPath(path, dashPath)) {
      const res = await handleDash(request, env, config, dashPath, log);
      log("request", { route: "dash", method: request.method, status: res.status });
      return res;
    }

    // OAuth discovery, registration, token and sign-in routes are the
    // provider's (protocol endpoints) or its defaultHandler's (authorize,
    // callback); anything else 404s there.
    return buildProvider(providerOpts).fetch(request, env, ctx);
  }

  return { fetch };
}
