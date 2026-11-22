/**
 * Ask session tokens: after Turnstile passes on a conversation's first turn, later
 * turns carry `x-ask-session` instead of a new Turnstile token.
 *
 * Token: `<expiryMs>.<base64url HMAC-SHA256(secret, "<conversationId>.<expiryMs>")>`.
 * Bound to one conversation id; sliding expiry (each answer issues a fresh token).
 * Verification uses `crypto.subtle.verify`, which compares in constant time.
 */

/** Default token life; `ask.sessionHours` overrides it (handler passes `ttlMs`). */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** A fresh token for `conversationId`, valid for `ttlMs` from `now`. */
export async function issueSession(secret: string, conversationId: string, now = Date.now(), ttlMs = SESSION_TTL_MS): Promise<string> {
  const expiry = now + ttlMs;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(`${conversationId}.${expiry}`));
  return `${expiry}.${toBase64Url(new Uint8Array(sig))}`;
}

export type SessionCheck = "ok" | "missing" | "invalid" | "expired";

/** Checks a token against the conversation id it must be bound to. */
export async function verifySession(
  secret: string | undefined,
  conversationId: string,
  token: string | null | undefined,
  now = Date.now(),
): Promise<SessionCheck> {
  if (!token) return "missing";
  if (!secret) return "invalid";
  const dot = token.indexOf(".");
  if (dot <= 0 || token.length > 200) return "invalid";
  const expiryRaw = token.slice(0, dot);
  if (!/^\d{1,15}$/.test(expiryRaw)) return "invalid";
  const sig = fromBase64Url(token.slice(dot + 1));
  if (!sig || sig.length !== 32) return "invalid";
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    sig,
    encoder.encode(`${conversationId}.${expiryRaw}`),
  );
  if (!valid) return "invalid";
  // Expiry is checked after the signature so a forged token never reads as "expired".
  return Number(expiryRaw) > now ? "ok" : "expired";
}

/**
 * Visitor ids for the daily question limit: `<uuid>.<base64url HMAC-SHA256(secret, "visitor.<uuid>")>`.
 * Issued by the Worker (never chosen by the client), kept by the website and sent back as
 * `x-ask-visitor`. No expiry: the count resets each Vietnam day. A visitor who drops it gets
 * a new one after the next Turnstile check, which the per-IP daily limit bounds.
 */
const VISITOR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function issueVisitor(secret: string, id: string = crypto.randomUUID()): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(`visitor.${id}`));
  return `${id}.${toBase64Url(new Uint8Array(sig))}`;
}

/** The visitor id in a valid token, else null. */
export async function verifyVisitor(secret: string | undefined, token: string | null | undefined): Promise<string | null> {
  if (!token || !secret || token.length > 120) return null;
  const dot = token.indexOf(".");
  const id = token.slice(0, dot);
  if (dot <= 0 || !VISITOR_RE.test(id)) return null;
  const sig = fromBase64Url(token.slice(dot + 1));
  if (!sig || sig.length !== 32) return null;
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), sig, encoder.encode(`visitor.${id}`));
  return ok ? id : null;
}
