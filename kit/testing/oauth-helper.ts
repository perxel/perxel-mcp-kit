import type { Env } from "../core/env.js";

/**
 * In-process OAuth driver for gate tests (task 3.2): registers a DCR client,
 * walks authorize → consent → (stubbed) Access → callback → token, and hands
 * back a real bearer token the worker accepts. Nothing touches the network:
 * the Access token endpoint and JWKS URL are stubbed by patching
 * `globalThis.fetch`, and the id_token is signed with a throwaway RSA key.
 */

// Production sets this via `compatibility_flags`; without it the provider
// advertises `client_id_metadata_document_supported: false` even with CIMD
// enabled. Emulate the flag so tests see the production metadata.
const g = globalThis as Record<string, unknown>;
if (typeof g["Cloudflare"] !== "object" || g["Cloudflare"] === null) {
  g["Cloudflare"] = { compatibilityFlags: { global_fetch_strictly_public: true } };
}

export const TEST_PUBLIC_URL = "https://mcp.perxel.com";
export const TEST_REDIRECT_URI = "http://localhost:54321/callback";
export const TEST_ACCESS_SUB = "test-user";
export const TEST_ACCESS_EMAIL = "tester@example.com";

export const TEST_ACCESS = {
  authorizationUrl: "https://access-stub.test/authorize",
  tokenUrl: "https://access-stub.test/oauth/token",
  jwksUrl: "https://access-stub.test/cdn-cgi/access/certs",
  clientId: "test-access-client-id",
  clientSecret: "test-access-client-secret",
} as const;

/** In-memory KV: `get` with `{type:"json"}`, `put` (TTL ignored), `delete`, `list`. */
export function fakeKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: (async (key: string, opts?: unknown) => {
      const raw = store.get(key) ?? null;
      if (raw === null) return null;
      const type = (opts as { type?: string } | undefined)?.type;
      if (type === "json") return JSON.parse(raw) as unknown;
      if (type === "text" || type === undefined) return raw;
      return raw;
    }) as KVNamespace["get"],
    put: (async (key: string, value: string | ArrayBuffer | ReadableStream) => {
      store.set(key, typeof value === "string" ? value : "[binary]");
    }) as KVNamespace["put"],
    delete: (async (key: string) => void store.delete(key)) as KVNamespace["delete"],
    list: (async (opts?: { prefix?: string }) => {
      const prefix = opts?.prefix ?? "";
      return {
        keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      };
    }) as KVNamespace["list"],
  } as KVNamespace;
}

export interface FakeExecCtx {
  ctx: ExecutionContext;
  waited: Promise<unknown>[];
  drain(): Promise<void>;
}

export function fakeExecCtx(): FakeExecCtx {
  const waited: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void waited.push(p),
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return { ctx, waited, drain: () => Promise.all(waited).then(() => undefined) };
}

export interface GateTestEnv {
  env: Env;
  points: AnalyticsEngineDataPoint[];
}

/** Env with an in-memory OAUTH_KV, recording METRICS and open rate limiters. */
export function gateTestEnv(publicUrl = TEST_PUBLIC_URL, overrides: Record<string, unknown> = {}): GateTestEnv {
  const points: AnalyticsEngineDataPoint[] = [];
  const env = {
    MCP_PUBLIC_URL: publicUrl,
    IP_HASH_SALT: "gate-test-salt",
    COOKIE_ENCRYPTION_KEY: "gate-test-cookie-key-32-chars-min!!",
    ACCESS_CLIENT_ID: TEST_ACCESS.clientId,
    ACCESS_CLIENT_SECRET: TEST_ACCESS.clientSecret,
    ACCESS_TOKEN_URL: TEST_ACCESS.tokenUrl,
    ACCESS_AUTHORIZATION_URL: TEST_ACCESS.authorizationUrl,
    ACCESS_JWKS_URL: TEST_ACCESS.jwksUrl,
    OAUTH_KV: fakeKv(),
    METRICS: { writeDataPoint: (p?: AnalyticsEngineDataPoint) => void points.push(p!) },
    RATE_LIMITER: { limit: async () => ({ success: true }) },
    RATE_LIMITER_ANTHROPIC: { limit: async () => ({ success: true }) },
    ...overrides,
  } as unknown as Env;
  return { env, points };
}

function b64uEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64uEncodeJson(value: unknown): string {
  return b64uEncode(new TextEncoder().encode(JSON.stringify(value)));
}

/** A throwaway RSA key plus a matching JWKS; signs stub id_tokens with it. */
export async function makeAccessKey(kid = "test-kid"): Promise<{
  kid: string;
  jwks: { keys: (JsonWebKey & { kid: string })[] };
  signIdToken(claims: Record<string, unknown>): Promise<string>;
}> {
  const key = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pub = { ...((await crypto.subtle.exportKey("jwk", key.publicKey)) as JsonWebKey), kid };
  return {
    kid,
    jwks: { keys: [pub] },
    signIdToken: async (claims) => {
      const data = `${b64uEncodeJson({ alg: "RS256", kid, typ: "JWT" })}.${b64uEncodeJson(claims)}`;
      const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(data)));
      return `${data}.${b64uEncode(sig)}`;
    },
  };
}

/**
 * Stub the two Access endpoints our `access.ts` calls. Anything else falls
 * through to the real fetch (unused in these tests, but harmless).
 */
export function stubAccessFetch(jwks: { keys: unknown[] }, idToken: string): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (u === TEST_ACCESS.tokenUrl) {
      return Response.json({ access_token: "upstream-access", id_token: idToken, token_type: "Bearer" });
    }
    if (u === TEST_ACCESS.jwksUrl) return Response.json(jwks);
    return orig(input as string, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

/** Minimal cookie jar: the consent/upstream handles only work with cookies echoed back. */
export class Jar {
  private cookies = new Map<string, string>();
  store(res: Response): void {
    const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const c of setCookies) {
      const pair = c.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

export interface Caller {
  jar: Jar;
  call(path: string, init?: RequestInit): Promise<Response>;
}

/** Request driver with a cookie jar against an in-process worker. */
export function createCaller(
  worker: { fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> },
  env: Env,
  publicUrl = TEST_PUBLIC_URL,
): Caller {
  const jar = new Jar();
  const call = async (path: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const jarHeader = jar.header();
    if (jarHeader) headers.set("Cookie", jarHeader);
    const ex = fakeExecCtx();
    const res = await worker.fetch(new Request(`${publicUrl}${path}`, { ...init, headers }), env, ex.ctx);
    jar.store(res);
    await ex.drain();
    return res;
  };
  return { jar, call };
}

export interface MintOpts {
  publicUrl?: string;
  /** Scopes requested at authorize (default the private example scope). */
  scope?: string;
  redirectUri?: string;
}

export interface Minted {
  accessToken: string;
  refreshToken: string;
  clientId: string;
}

function newVerifier(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

async function s256(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return b64uEncode(digest);
}

/**
 * Drive the full in-process flow: `/register` → `/authorize` (GET consent,
 * POST allow) → stubbed Access → `/callback` → `/token`. Returns a real
 * access token plus its refresh token and client id.
 */
export async function mintToken(
  worker: { fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> },
  env: Env,
  opts: MintOpts = {},
): Promise<Minted> {
  const publicUrl = opts.publicUrl ?? TEST_PUBLIC_URL;
  const redirectUri = opts.redirectUri ?? TEST_REDIRECT_URI;
  const scope = opts.scope ?? "private:read";
  const { call } = createCaller(worker, env, publicUrl);

  // 1. Dynamic client registration (public client, like Claude).
  const reg = await call("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      client_name: "gate-test",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (reg.status !== 201 && reg.status !== 200) {
    throw new Error(`register failed: ${reg.status} ${await reg.text()}`);
  }
  const regBody = (await reg.json()) as { client_id: string };
  const clientId = regBody.client_id;

  // 2. Authorize: the consent page…
  const verifier = newVerifier();
  const challenge = await s256(verifier);
  const authParams = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state: "test-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${publicUrl}/mcp`,
  });
  const consentPage = await call(`/authorize?${authParams.toString()}`);
  if (consentPage.status !== 200) throw new Error(`authorize page: ${consentPage.status} ${await consentPage.text()}`);
  const html = await consentPage.text();
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
  if (!handle) throw new Error("consent page has no handle");

  // …approved, which redirects to Access…
  const approved = await call("/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ handle, decision: "allow", ...(scope ? { scope } : {}) }).toString(),
  });
  if (approved.status !== 302) throw new Error(`approve: ${approved.status} ${await approved.text()}`);
  const accessLogin = new URL(approved.headers.get("location") ?? "");
  const state = accessLogin.searchParams.get("state");
  if (!state) throw new Error("no upstream state");

  // …whose callback we fake (the code comes from Access; the stubbed token
  // endpoint and JWKS do the rest).
  const cb = await call(`/callback?code=fake-access-code&state=${encodeURIComponent(state)}`);
  if (cb.status !== 302) throw new Error(`callback: ${cb.status} ${await cb.text()}`);
  const backTo = new URL(cb.headers.get("location") ?? "");
  const code = backTo.searchParams.get("code");
  if (!code) throw new Error("no authorization code");

  // 3. Code for tokens (form-urlencoded, as Claude sends it).
  const tok = await call("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    }).toString(),
  });
  if (tok.status !== 200) throw new Error(`token: ${tok.status} ${await tok.text()}`);
  const tokBody = (await tok.json()) as { access_token: string; refresh_token?: string };
  return { accessToken: tokBody.access_token, refreshToken: tokBody.refresh_token ?? "", clientId };
}
