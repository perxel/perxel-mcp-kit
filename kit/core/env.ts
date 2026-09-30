/**
 * The Worker's bindings, vars and secrets (section 3.2 of the task list).
 * The clone's `src/index.ts` uses this type via `ToolContext`; `wrangler types`
 * generates a narrower `Env` that is assignable to it.
 */
export interface Env {
  OAUTH_KV: KVNamespace;
  CONTENT_KV: KVNamespace;
  METRICS: AnalyticsEngineDataset;
  RATE_LIMITER: RateLimit;
  RATE_LIMITER_ANTHROPIC: RateLimit;
  MCP_PUBLIC_URL: string;
  CONTENT_URL?: string;
  IP_HASH_SALT?: string;
  COOKIE_ENCRYPTION_KEY?: string;
  ACCESS_CLIENT_ID?: string;
  ACCESS_CLIENT_SECRET?: string;
  ACCESS_TOKEN_URL?: string;
  ACCESS_AUTHORIZATION_URL?: string;
  ACCESS_JWKS_URL?: string;
  /** Dashboard mount path on this Worker (default "/dash"; "off" disables it). */
  DASH_PATH?: string;
  /** Service binding to the account's metrics proxy (kit/metrics-proxy). */
  METRICS_PROXY?: Fetcher;
  /** This MCP's proxy key (secret): the proxy maps its SHA-256 to `mcp_<slug>`. */
  DASH_PROXY_KEY?: string;
  /** Access team domain guarding the dashboard, e.g. "perxel.cloudflareaccess.com". */
  DASH_ACCESS_TEAM?: string;
  /** Application Audience (AUD) tag of the Access app protecting the dashboard path. */
  DASH_ACCESS_AUD?: string;
  [key: string]: unknown;
}
