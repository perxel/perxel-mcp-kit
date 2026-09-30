import { isAnthropicCloudCaller } from "./anthropic-range.js";
import { ipCallerKey } from "./caller.js";
import type { Env } from "./env.js";

export interface RateLimitDecision {
  allowed: boolean;
  /** The anonymous per-IP caller key — independent of which bucket limited the request. */
  callerKey: string | null;
  anthropicCloud: boolean;
}

/**
 * 60/min per caller key, except callers from Anthropic's published connector range
 * (claude.ai, Claude Desktop, mobile, Cowork — see anthropic-range.ts), who share one
 * 600/min bucket keyed `"anthropic"` instead of their own IP: claude.ai calls from a
 * handful of Anthropic IPs on behalf of many real users, so a per-IP bucket would be
 * far too tight for them. A bearer token's user key isn't known yet at this point
 * (it runs before auth), so the per-IP key is used for everyone in v1.
 * A missing binding (tests, local dev) means allow.
 */
export async function checkRateLimit(env: Env, ip: string | undefined): Promise<RateLimitDecision> {
  const anthropicCloud = isAnthropicCloudCaller(ip);
  const key = await ipCallerKey(env.IP_HASH_SALT, ip);

  if (anthropicCloud) {
    const limiter = env.RATE_LIMITER_ANTHROPIC;
    if (!limiter) return { allowed: true, callerKey: key, anthropicCloud };
    const { success } = await limiter.limit({ key: "anthropic" });
    return { allowed: success, callerKey: key, anthropicCloud };
  }

  const limiter = env.RATE_LIMITER;
  if (!limiter || !key) return { allowed: true, callerKey: key, anthropicCloud };
  const { success } = await limiter.limit({ key });
  return { allowed: success, callerKey: key, anthropicCloud };
}
