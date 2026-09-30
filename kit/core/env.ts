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
  [key: string]: unknown;
}
