/**
 * RS256 JWT signature check against a JWKS URL, shared by the Access sign-in
 * (`access.ts`, the OIDC id_token) and the dashboard gate (`dash.ts`, the
 * `Cf-Access-Jwt-Assertion` header). Callers check their own claims
 * (aud, iss, exp); this only proves the token was signed by a key at `jwksUrl`.
 */

export function b64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Verify `token`'s RS256 signature with the matching key from `jwksUrl`; returns the payload. Throws otherwise. */
export async function verifyRs256Jwt<T>(token: string, jwksUrl: string): Promise<T> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed jwt");
  const header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0]))) as { alg?: string; kid?: string };
  if (header.alg !== "RS256") throw new Error(`unexpected jwt alg ${header.alg}`);
  const jwksRes = await fetch(jwksUrl);
  if (!jwksRes.ok) throw new Error("could not fetch JWKS");
  const jwks = (await jwksRes.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
  const keys = jwks.keys ?? [];
  const jwk = keys.find((k) => k.kid === header.kid) ?? (keys.length === 1 ? keys[0] : undefined);
  if (!jwk) throw new Error("no matching key");
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlDecode(parts[2]), signed);
  if (!ok) throw new Error("bad jwt signature");
  return JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]))) as T;
}
