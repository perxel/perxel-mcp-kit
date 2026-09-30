import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { McpConfig } from "./config.js";
import type { Env } from "./env.js";

/**
 * OAuth + gate wiring (task 3.5). Pure helpers live here; the request flow
 * itself is composed in `worker.ts`, the consent HTML in `consent.ts`, and
 * the Cloudflare Access sign-in in `access.ts` (the only file that knows
 * about Access).
 */

// The exact option names below were checked against
// `node_modules/@cloudflare/workers-oauth-provider/dist/oauth-provider.d.ts`
// (rule 4): apiRoute/apiHandler/defaultHandler, authorizeEndpoint,
// tokenEndpoint, clientRegistrationEndpoint, scopesSupported,
// clientIdMetadataDocumentEnabled, resourceMetadata, clientRegistrationCallback.

/** Claude's OAuth callback. Claude Code uses a loopback URL on any port instead. */
export const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

/**
 * Redirect URIs accepted in v1: Claude's callback exactly, plus
 * `http://localhost/callback` and `http://127.0.0.1/callback` on any port
 * (Claude Code picks a free loopback port). Anything else is refused, both at
 * DCR time and at authorize time.
 */
export function isAllowedRedirectUri(uri: string): boolean {
  if (uri === CLAUDE_CALLBACK) return true;
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") return false;
  if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") return false;
  if (parsed.pathname !== "/callback") return false;
  if (parsed.search || parsed.hash) return false;
  return true;
}

/** The MCP URL users paste: `config.publicUrl + "/mcp"`. `resource` must equal it exactly. */
export function mcpResourceUrl(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/mcp`;
}

/** Origin of the public URL: the `authorization_servers` entry in our metadata. */
export function publicOrigin(publicUrl: string): string {
  return new URL(publicUrl).origin;
}

/**
 * The RFC 9728 protected-resource document. The kit serves it directly for
 * both `/.well-known/oauth-protected-resource` (which the provider 404s) and
 * `/mcp` (which the provider would also serve identically); one helper means
 * the two can never drift apart.
 */
export function resourceMetadataDoc(publicUrl: string): Record<string, unknown> {
  return {
    resource: mcpResourceUrl(publicUrl),
    authorization_servers: [publicOrigin(publicUrl)],
    bearer_methods_supported: ["header"],
  };
}

/**
 * The gate's 401 for a private call without a token (task 3.5). It must be a
 * real 401: a 200 tool error never starts Claude's sign-in. `scopes` are the
 * distinct scopes of the private tools in this request.
 */
export function unauthorizedResponse(publicUrl: string, scopes: string[]): Response {
  const scope = [...new Set(scopes)].join(" ");
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "WWW-Authenticate":
        `Bearer resource_metadata="${publicUrl.replace(/\/+$/, "")}/.well-known/oauth-protected-resource/mcp"` +
        `, scope="${scope}"`,
    },
  });
}

export interface GateCall {
  name: string;
  id: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Tool names from a parsed JSON-RPC body (a batch may hold several). */
export function gateCallsFromBody(body: unknown): GateCall[] {
  const msgs = Array.isArray(body) ? body : [body];
  const out: GateCall[] = [];
  for (const m of msgs) {
    if (!isRecord(m) || m["method"] !== "tools/call" || !isRecord(m["params"])) continue;
    if (typeof m["params"]["name"] !== "string") continue;
    out.push({ name: m["params"]["name"] as string, id: (m["id"] ?? null) as unknown });
  }
  return out;
}

/**
 * Tool names from the 2026 `Mcp-Method`/`Mcp-Name` headers. Only a fallback:
 * the body parse wins when it finds a `tools/call`.
 */
export function gateCallsFromHeaders(request: Request): GateCall[] {
  if (request.headers.get("Mcp-Method") !== "tools/call") return [];
  const name = request.headers.get("Mcp-Name");
  return name ? [{ name, id: null }] : [];
}

/** The scopes of the private tools named in this request (unknown names are ignored). */
export function privateScopesFor(config: McpConfig, names: string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    const tool = config.tools.find((t) => t.name === name);
    if (tool?.access === "private" && tool.scope) out.push(tool.scope);
  }
  return [...new Set(out)];
}

/** Scopes the grant still needs for this request's private tools (the 403 `scope` list). */
export function missingScopesFor(config: McpConfig, names: string[], granted: string[]): string[] {
  return privateScopesFor(config, names).filter((s) => !granted.includes(s));
}

/** True when any named tool is private (an unknown name alone never requires auth). */
export function needsAuthFor(config: McpConfig, names: string[]): boolean {
  return names.some((n) => config.tools.find((t) => t.name === n)?.access === "private");
}

export interface ProviderHandlers {
  apiHandler: { fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> };
  defaultHandler: { fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> };
}

/**
 * Options for the one-Worker shape: the whole `/mcp` route is protected, so
 * the gate in `worker.ts` passes public calls through and answers 401 itself.
 * PKCE S256-only and refresh-token rotation are the library defaults (checked
 * in its dist: `codeChallengeMethods: ["S256"]`, previous-token grace); CIMD
 * stays on for future ChatGPT/Gemini support.
 */
export function providerOptionsFor(config: McpConfig, publicUrl: string, handlers: ProviderHandlers) {
  const resource = mcpResourceUrl(publicUrl);
  return {
    apiRoute: "/mcp",
    apiHandler: handlers.apiHandler,
    defaultHandler: handlers.defaultHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    scopesSupported: Object.keys(config.scopes),
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: {
      resource,
      authorization_servers: [publicOrigin(publicUrl)],
    },
    // DCR stays on, but v1 only allows Claude's redirect URIs.
    clientRegistrationCallback: ({ clientMetadata }: { clientMetadata: Record<string, unknown> }) => {
      const uris = clientMetadata["redirect_uris"];
      if (!Array.isArray(uris)) return; // let the library report a malformed body
      if (uris.every((u) => typeof u === "string" && isAllowedRedirectUri(u))) return;
      return {
        code: "invalid_client_metadata",
        description:
          "redirect_uris must be https://claude.ai/api/mcp/auth_callback or " +
          "http://localhost[:port]/callback (http://127.0.0.1[:port]/callback)",
        status: 400,
      };
    },
  };
}

export type ProviderOptions = ReturnType<typeof providerOptionsFor>;

/** One provider per request: `resource` comes from `env.MCP_PUBLIC_URL`. */
export function buildProvider(options: ProviderOptions): OAuthProvider<Env> {
  return new OAuthProvider(options as ConstructorParameters<typeof OAuthProvider<Env>>[0]);
}
