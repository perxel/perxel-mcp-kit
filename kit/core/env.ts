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
  /** Access team domain guarding the dashboard, e.g. "your-team.cloudflareaccess.com". */
  DASH_ACCESS_TEAM?: string;
  /** Application Audience (AUD) tag of the Access app protecting the dashboard path. */
  DASH_ACCESS_AUD?: string;
  /** "true" serves the dashboard without an Access sign-in (public demo). Anything else keeps it behind Access. */
  DASH_PUBLIC?: string;
  /** Ask (only when `config.ask` is set): conversation store. */
  ASK_DB?: D1Database;
  /** Ask: per-IP limit, its own namespace (limit = ask.limits.perIpPerMinute). */
  ASK_RATE_LIMITER?: RateLimit;
  /** Ask: OpenRouter key (secret). */
  OPENROUTER_API_KEY?: string;
  /** Ask: Turnstile widget secret. */
  TURNSTILE_SECRET?: string;
  /** Ask: HMAC key for session tokens (secret, random). */
  ASK_SESSION_SECRET?: string;
  /** Ask: AUD tag of the Access app on <host>/dash/conversations; defaults to DASH_ACCESS_AUD. */
  ASK_DASH_ACCESS_AUD?: string;
  /** Ask, local dev only: Langfuse keys "publicKey:secretKey" for evals. Never set in production. */
  ASK_DEV_LANGFUSE?: string;
  [key: string]: unknown;
}
