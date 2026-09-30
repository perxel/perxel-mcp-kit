import type { AuthRequest, OAuthHelpers, ResumedUpstream } from "@cloudflare/workers-oauth-provider";
import { AuthorizationError } from "@cloudflare/workers-oauth-provider";
import { consentSecurityHeaders, renderConsentPage, renderOAuthErrorPage } from "./consent.js";
import { isAllowedRedirectUri } from "./oauth.js";
import type { McpConfig } from "./config.js";
import type { Env } from "./env.js";
import { verifyRs256Jwt } from "./jwt.js";

/**
 * Cloudflare Access (OIDC) sign-in, adapted from Cloudflare's
 * `remote-mcp-cf-access` template (`src/access-handler.ts` +
 * `src/workers-oauth-utils.ts`, fetched 2026-09-30). The template leans on
 * `McpAgent`/Durable Objects, which the kit doesn't use; here the same flow
 * runs on the library's consent + upstream helpers instead of the template's
 * hand-rolled state and CSRF cookies:
 *
 *   GET /authorize  → consent page (or straight to Access when remembered)
 *   POST /authorize → Allow: save approved scopes + PKCE verifier with
 *                     `beginUpstream`, redirect to Access; Deny: back to client
 *   GET /callback   → recover with `finishUpstream`, exchange the code at
 *                     Access, verify the id_token, `completeAuthorization`
 *
 * This is the only file that touches the ACCESS_* secrets.
 */

interface UpstreamData {
  codeVerifier: string;
  scope: string[];
}

const ACCESS_SCOPE = "openid email profile";

function errorPage(status: number, title: string, message: string): Response {
  return new Response(renderOAuthErrorPage(title, message), {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...consentSecurityHeaders() },
  });
}

/** Library authorization errors go back to the client when safe, else render locally. */
function authorizationErrorResponse(err: AuthorizationError): Response {
  if (err.redirectTo) return Response.redirect(err.redirectTo, 302);
  return errorPage(400, "Authorization error", `${err.code}: ${err.description}`);
}

/** PKCE verifier: 64 chars from the unreserved set (RFC 7636). */
function newCodeVerifier(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

async function s256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64urlEncode(new Uint8Array(digest));
}

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function callbackUrl(request: Request): string {
  return new URL("/callback", request.url).href;
}

/** Start the Access login: stash the verifier + approved scopes, redirect to Access. */
async function redirectToAccess(
  request: Request,
  env: Env,
  api: OAuthHelpers,
  approved: AuthRequest,
  approvedScope: string[],
): Promise<Response> {
  const authzUrl = env.ACCESS_AUTHORIZATION_URL;
  const clientId = env.ACCESS_CLIENT_ID;
  if (!authzUrl || !clientId) return errorPage(500, "Sign-in not configured", "The server is missing its Access settings.");
  const codeVerifier = newCodeVerifier();
  const upstream = await api.beginUpstream(approved, { data: { codeVerifier, scope: approvedScope } });
  const dest = new URL(authzUrl);
  dest.searchParams.set("response_type", "code");
  dest.searchParams.set("client_id", clientId);
  dest.searchParams.set("redirect_uri", callbackUrl(request));
  dest.searchParams.set("scope", ACCESS_SCOPE);
  dest.searchParams.set("state", upstream.state);
  dest.searchParams.set("code_challenge", await s256Challenge(codeVerifier));
  dest.searchParams.set("code_challenge_method", "S256");
  const headers = new Headers();
  upstream.headers.forEach((v, k) => headers.append(k, v));
  headers.set("location", dest.href);
  return new Response(null, { status: 302, headers });
}

export async function handleAuthorizeGet(
  request: Request,
  env: Env,
  api: OAuthHelpers,
  config: McpConfig,
): Promise<Response> {
  let authRequest: AuthRequest;
  try {
    authRequest = await api.parseAuthRequest(request);
  } catch (err) {
    if (err instanceof AuthorizationError) return authorizationErrorResponse(err);
    throw err;
  }
  // DCR stays on, but v1 only serves Claude: refuse anything else right here,
  // rendered locally (the redirect target itself is untrusted).
  if (!isAllowedRedirectUri(authRequest.redirectUri)) {
    return errorPage(
      400,
      "Redirect URI not allowed",
      "This server only allows Claude (https://claude.ai/api/mcp/auth_callback) " +
        "and Claude Code (http://localhost[:port]/callback).",
    );
  }
  const secret = env.COOKIE_ENCRYPTION_KEY;
  try {
    if (secret && (await api.isConsentRemembered(request, authRequest, { secret }))) {
      return await redirectToAccess(request, env, api, authRequest, authRequest.scope);
    }
  } catch (err) {
    if (err instanceof AuthorizationError) return authorizationErrorResponse(err);
    throw err;
  }
  let consent: { handle: string; headers: Headers };
  let facts: { clientName: string; redirectHost: string; redirectIsLoopback: boolean; scope: string[] };
  try {
    consent = await api.beginConsent(authRequest);
    facts = await api.describeConsent(authRequest);
  } catch (err) {
    if (err instanceof AuthorizationError) return authorizationErrorResponse(err);
    throw err;
  }
  const page = renderConsentPage({
    mcpName: config.name,
    clientName: facts.clientName,
    redirectHost: facts.redirectHost,
    redirectIsLoopback: facts.redirectIsLoopback,
    scopes: facts.scope.map((name) => ({ name, description: config.scopes[name] ?? "" })),
    handle: consent.handle,
  });
  const headers = new Headers(consent.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  for (const [k, v] of Object.entries(consentSecurityHeaders())) headers.set(k, v);
  return new Response(page, { headers });
}

export async function handleAuthorizePost(
  request: Request,
  env: Env,
  api: OAuthHelpers,
  config: McpConfig,
): Promise<Response> {
  const form = await request.formData();
  const handle = form.get("handle");
  if (typeof handle !== "string" || !handle) return errorPage(400, "Bad request", "Missing consent handle.");
  if (form.get("decision") !== "allow") {
    try {
      const denied = await api.denyConsent(request, handle);
      const headers = new Headers(denied.headers);
      headers.set("location", denied.redirectTo);
      return new Response(null, { status: 302, headers });
    } catch (err) {
      if (err instanceof AuthorizationError) return authorizationErrorResponse(err);
      throw err;
    }
  }
  const supported = new Set(Object.keys(config.scopes));
  const scope = form.getAll("scope").filter((s): s is string => typeof s === "string" && supported.has(s));
  try {
    const secret = env.COOKIE_ENCRYPTION_KEY;
    const approved = await api.approveConsent(request, handle, {
      scope,
      ...(secret ? { remember: { secret } } : {}),
    });
    const headers = new Headers(approved.headers);
    const access = await redirectToAccess(request, env, api, approved.request, scope);
    access.headers.forEach((v, k) => headers.append(k, v));
    headers.set("location", access.headers.get("location") ?? "");
    return new Response(null, { status: 302, headers });
  } catch (err) {
    if (err instanceof AuthorizationError) return authorizationErrorResponse(err);
    throw err;
  }
}

interface AccessClaims {
  sub: string;
  email?: string;
  exp?: number;
  aud?: string | string[];
}

/** Exchange the Access code for tokens (form-urlencoded, like every OAuth token endpoint). */
async function exchangeAccessCode(
  env: Env,
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<{ idToken: string } | Response> {
  const res = await fetch(env.ACCESS_TOKEN_URL as string, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: env.ACCESS_CLIENT_ID as string,
      client_secret: env.ACCESS_CLIENT_SECRET as string,
      code_verifier: codeVerifier,
    }).toString(),
  });
  if (!res.ok) return errorPage(502, "Sign-in failed", "The identity provider refused the login. Try again.");
  const body = (await res.json()) as { id_token?: string };
  if (!body.id_token) return errorPage(502, "Sign-in failed", "The identity provider returned no identity token.");
  return { idToken: body.id_token };
}

/** Verify the Access id_token signature (RS256) and lifetime against the Access JWKS. */
async function verifyAccessIdToken(env: Env, idToken: string): Promise<AccessClaims> {
  const claims = await verifyRs256Jwt<AccessClaims>(idToken, env.ACCESS_JWKS_URL as string);
  if (typeof claims.exp === "number" && claims.exp < Math.floor(Date.now() / 1000) - 60) {
    throw new Error("expired id_token");
  }
  // The signature against our own JWKS URL is the trust anchor; aud pins the
  // token to this Access app when the claim is present.
  if (claims.aud !== undefined) {
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(env.ACCESS_CLIENT_ID as string)) throw new Error("id_token for another app");
  }
  if (!claims.sub) throw new Error("id_token has no subject");
  return claims;
}

export async function handleCallback(
  request: Request,
  env: Env,
  api: OAuthHelpers,
  _config: McpConfig,
): Promise<Response> {
  if (!env.ACCESS_TOKEN_URL || !env.ACCESS_JWKS_URL || !env.ACCESS_CLIENT_ID || !env.ACCESS_CLIENT_SECRET) {
    return errorPage(500, "Sign-in not configured", "The server is missing its Access settings.");
  }
  let resumed: ResumedUpstream<UpstreamData>;
  try {
    resumed = await api.finishUpstream<UpstreamData>(request);
  } catch (err) {
    if (err instanceof AuthorizationError) return authorizationErrorResponse(err);
    throw err;
  }
  const code = new URL(request.url).searchParams.get("code");
  if (!code) return errorPage(400, "Sign-in failed", "The identity provider returned no code.");
  const exchanged = await exchangeAccessCode(env, code, callbackUrl(request), resumed.data.codeVerifier);
  if (exchanged instanceof Response) return exchanged;
  let claims: AccessClaims;
  try {
    claims = await verifyAccessIdToken(env, exchanged.idToken);
  } catch {
    return errorPage(502, "Sign-in failed", "The identity could not be verified. Try again.");
  }
  const scope = resumed.data.scope;
  try {
    const { redirectTo } = await api.completeAuthorization({
      request: resumed.request,
      userId: claims.sub,
      metadata: { email: claims.email ?? null },
      scope,
      props: { userId: claims.sub, email: claims.email ?? null, scopes: scope },
    });
    const headers = new Headers(resumed.headers);
    headers.set("location", redirectTo);
    return new Response(null, { status: 302, headers });
  } catch (err) {
    if (err instanceof AuthorizationError) return authorizationErrorResponse(err);
    throw err;
  }
}
