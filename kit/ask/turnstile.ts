/**
 * Cloudflare Turnstile check for an Ask conversation's first turn: proves the
 * request comes from a real browser on one of the allowed sites before any
 * model call. https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 */

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface TurnstileResult {
  ok: boolean;
  /** Why it failed, for logs only (never shown to the visitor). */
  reason?: "missing_token" | "missing_secret" | "rejected" | "hostname" | "network";
}

/** Hostnames the widget may have been solved on: those of the allowed origins. */
export function allowedHostnames(allowedOrigins: string[]): Set<string> {
  const out = new Set<string>();
  for (const o of allowedOrigins) {
    try {
      out.add(new URL(o).hostname);
    } catch {
      // validateAskConfig already rejects malformed origins.
    }
  }
  return out;
}

export async function verifyTurnstile(opts: {
  secret: string | undefined;
  token: string | undefined | null;
  ip?: string;
  allowedOrigins: string[];
  /** Local dev: Cloudflare's test keys report hostname "example.com"; accept any hostname. */
  local?: boolean;
  fetcher?: typeof fetch;
}): Promise<TurnstileResult> {
  if (!opts.token || opts.token.length > 2048) return { ok: false, reason: "missing_token" };
  if (!opts.secret) return { ok: false, reason: "missing_secret" };
  const body = new FormData();
  body.append("secret", opts.secret);
  body.append("response", opts.token);
  if (opts.ip) body.append("remoteip", opts.ip);
  let data: { success?: boolean; hostname?: string };
  try {
    const res = await (opts.fetcher ?? fetch)(SITEVERIFY_URL, { method: "POST", body });
    data = (await res.json()) as typeof data;
  } catch {
    return { ok: false, reason: "network" };
  }
  if (data.success !== true) return { ok: false, reason: "rejected" };
  if (!opts.local && (!data.hostname || !allowedHostnames(opts.allowedOrigins).has(data.hostname))) {
    return { ok: false, reason: "hostname" };
  }
  return { ok: true };
}
