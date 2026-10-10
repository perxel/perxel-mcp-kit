/**
 * Ask session tokens: after Turnstile passes on a conversation's first turn, later
 * turns carry `x-ask-session` instead of a new Turnstile token.
 *
 * Token: `<expiryMs>.<base64url HMAC-SHA256(secret, "<conversationId>.<expiryMs>")>`.
 * Bound to one conversation id; sliding expiry (each answer issues a fresh token).
 * Verification uses `crypto.subtle.verify`, which compares in constant time.
 */

export const SESSION_TTL_MS = 30 * 60 * 1000;

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

/** A fresh token for `conversationId`, valid for `SESSION_TTL_MS` from `now`. */
export async function issueSession(secret: string, conversationId: string, now = Date.now()): Promise<string> {
  const expiry = now + SESSION_TTL_MS;
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
