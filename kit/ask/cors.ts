/**
 * CORS for `/ask` (plan 010, contract "POST /ask"): an exact-origin allowlist
 * with a localhost carve-out for local dev, the preflight reply, and the
 * headers every successful Ask response carries.
 *
 * Exact matches only: no wildcard, no prefix/suffix or substring matching, so
 * `https://example.com.evil.com` never passes an `https://example.com` entry.
 */
import { isLocalHost } from "../core/dash.js";

/** `http://localhost:<port>` or `http://127.0.0.1:<port>` (same shape as config.ts LOCAL_ORIGIN_RE). */
const LOCAL_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

/**
 * The request's Origin when it may call /ask, else null:
 * an exact match against `allowedOrigins`, or any `http://localhost:<port>` /
 * `http://127.0.0.1:<port>` origin when the request URL host is itself local
 * (`wrangler dev`; reuses dash.ts's local-host check).
 */
export function allowedOrigin(request: Request, allowedOrigins: string[]): string | null {
  const origin = request.headers.get("origin");
  if (origin === null) return null;
  if (allowedOrigins.includes(origin)) return origin;
  if (LOCAL_ORIGIN_RE.test(origin) && isLocalHost(new URL(request.url))) return origin;
  return null;
}

/** The `OPTIONS` reply: 204 with the CORS headers when allowed, 403 `{"code":"origin"}` otherwise. */
export function preflight(request: Request, allowedOrigins: string[]): Response {
  const origin = allowedOrigin(request, allowedOrigins);
  if (origin === null) {
    return new Response(JSON.stringify({ code: "origin" }), {
      status: 403,
      headers: { "content-type": "application/json; charset=utf-8", vary: "Origin" },
    });
  }
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "POST",
      "access-control-allow-headers": "content-type, x-ask-session",
      "access-control-max-age": "600",
      vary: "Origin",
    },
  });
}

/**
 * The CORS headers on an actual response, keeping status and streaming body
 * (`response.body` is passed through untouched, not read).
 */
export function withCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-expose-headers", "x-ask-session");
  const vary = headers.get("vary");
  if (vary === null) headers.set("vary", "Origin");
  else if (!vary.split(",").some((v) => v.trim().toLowerCase() === "origin")) headers.set("vary", `${vary}, Origin`);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
