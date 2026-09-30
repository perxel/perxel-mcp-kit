/**
 * Metrics proxy Worker: one per Cloudflare account, shared by every MCP in
 * it. Holds the only real Analytics Engine token (`CF_API_TOKEN`, Account
 * Analytics Read) and gives each MCP its own key (`PROXY_KEYS`: JSON mapping
 * the SHA-256 hex of a key to its dataset, e.g. `{ "<hex>": "mcp_example" }`).
 *
 * Callers are the MCP Workers' dashboards (`kit/core/dash.ts`), over a
 * service binding; the proxy has no public URL (`workers_dev: false`). A
 * query arrives as `GET ?query=` or a POST body (raw SQL, or JSON with a
 * `query` field), with the key as `Authorization: Bearer <key>` (basic auth
 * with the key as the password also works, for curl while debugging).
 *
 * Every query is checked by `validateQuery` before forwarding; anything that
 * reads outside the key's dataset is rejected with 403 and never reaches
 * Cloudflare. Forwarded responses return the upstream body and status as-is.
 */

import { sha256Hex } from "../core/caller.js";
import { validateQuery } from "./validate.js";

export interface MetricsProxyEnv {
  /** Account Analytics Read token (secret, `wrangler secret put`). */
  CF_API_TOKEN: string;
  /** 32-char Cloudflare account id (var). */
  CF_ACCOUNT_ID: string;
  /** JSON `{ "<sha256 hex of key>": "<dataset>" }` (secret). */
  PROXY_KEYS: string;
  [key: string]: unknown;
}

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status });
}

/** Dashboard key from `Authorization: Bearer` or basic-auth password. */
function extractKey(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const bearer = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (bearer) return bearer[1].trim() || null;
  const basic = /^Basic\s+(.+)$/i.exec(header.trim());
  if (basic) {
    try {
      const decoded = atob(basic[1].trim());
      const colon = decoded.indexOf(":");
      // The plugin's basic-auth password field holds the key; a bare key
      // without `user:` also works.
      const password = colon >= 0 ? decoded.slice(colon + 1) : decoded;
      return password.trim() || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Query from `?query=`, a JSON `{query}` POST body, or a raw SQL POST body. */
async function extractQuery(request: Request): Promise<string | null> {
  const param = new URL(request.url).searchParams.get("query");
  if (param !== null && param.trim() !== "") return param;
  if (request.method === "GET") return null;
  const body = await request.text();
  if (body.trim() === "") return param?.trim() ? param : null;
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("json")) {
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === "object" && typeof (parsed as { query?: unknown }).query === "string") {
        const q = (parsed as { query: string }).query;
        return q.trim() === "" ? null : q;
      }
    } catch {
      // Not JSON after all: fall through and treat the body as raw SQL.
    }
  }
  return body;
}

export default {
  async fetch(request: Request, env: MetricsProxyEnv): Promise<Response> {
    if (request.method !== "GET" && request.method !== "POST") {
      return json(405, { error: "method_not_allowed" });
    }
    if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) {
      console.error("metrics-proxy: missing CF_API_TOKEN or CF_ACCOUNT_ID");
      return json(500, { error: "server_misconfigured" });
    }
    let keys: Record<string, string>;
    try {
      keys = JSON.parse(env.PROXY_KEYS ?? "") as Record<string, string>;
      if (!keys || typeof keys !== "object" || Array.isArray(keys)) throw new Error("not an object");
    } catch {
      console.error("metrics-proxy: PROXY_KEYS is not a JSON object");
      return json(500, { error: "server_misconfigured" });
    }

    const key = extractKey(request);
    // Same response for a missing and a wrong key: don't tell callers apart.
    const dataset = key ? keys[await sha256Hex(key)] : undefined;
    if (!key || !dataset) return json(401, { error: "unauthorized" });

    const query = await extractQuery(request);
    if (!query) return json(400, { error: "missing_query" });

    const verdict = validateQuery(query, dataset);
    if (!verdict.ok) return json(403, { error: "query_rejected", reason: verdict.reason });

    let upstream: Response;
    try {
      upstream = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "text/plain" },
          body: query,
        },
      );
    } catch (err) {
      console.error(`metrics-proxy: upstream fetch failed: ${err instanceof Error ? err.message : err}`);
      return json(502, { error: "upstream_unavailable" });
    }
    // Body and status pass through untouched (usually JSON with FORMAT JSON).
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("Content-Type") ?? "application/json" },
    });
  },
};
