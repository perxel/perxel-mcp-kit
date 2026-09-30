import { describe, expect, it } from "vitest";
import { defineConfig } from "./config.js";
import {
  DASH_RANGES,
  type DashRange,
  checkDashAccess,
  dashPathFor,
  dashQueries,
  datasetFor,
  handleDash,
  isDashPath,
} from "./dash.js";
import type { Env } from "./env.js";
import { createWorker } from "./worker.js";
import { validateQuery } from "../metrics-proxy/validate.js";

const config = defineConfig({
  slug: "perxel-demo",
  name: "Demo MCP",
  version: "1.2.3",
  description: "Test config.",
  scopes: {},
  tools: [],
  docs: { contact: "hello@perxel.com" },
});

const NOW = Date.UTC(2026, 8, 30, 12, 34, 0);
const noLog = () => {};

function b64url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let s = "";
  for (const b of raw) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** An RSA key pair plus a signer, with the JWKS served from a stubbed fetch. */
async function accessKeys() {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = { ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey), kid: "k1" };
  async function sign(claims: Record<string, unknown>): Promise<string> {
    const head = b64url(JSON.stringify({ alg: "RS256", kid: "k1" }));
    const body = b64url(JSON.stringify(claims));
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
  }
  return { jwk, sign };
}

async function withJwks<T>(jwk: JsonWebKey, fn: () => Promise<T>): Promise<{ result: T; urls: string[] }> {
  const urls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return Response.json({ keys: [jwk] });
  }) as typeof fetch;
  try {
    return { result: await fn(), urls };
  } finally {
    globalThis.fetch = real;
  }
}

const TEAM = "perxel.cloudflareaccess.com";
const AUD = "aud-tag-123";

describe("dashPathFor", () => {
  it("defaults to /dash and normalizes slashes", () => {
    expect(dashPathFor({})).toBe("/dash");
    expect(dashPathFor({ DASH_PATH: "" })).toBe("/dash");
    expect(dashPathFor({ DASH_PATH: "stats/" })).toBe("/stats");
    expect(dashPathFor({ DASH_PATH: "/ops/metrics" })).toBe("/ops/metrics");
  });

  it("is disabled by off, root, reserved or malformed paths", () => {
    for (const p of ["off", "OFF", "/", "/mcp", "/health", "/.well-known/x", "/callback", "/a b", "/a?b"]) {
      expect(dashPathFor({ DASH_PATH: p }), p).toBeNull();
    }
  });

  it("matches the path and everything under it only", () => {
    expect(isDashPath("/dash", "/dash")).toBe(true);
    expect(isDashPath("/dash/", "/dash")).toBe(true);
    expect(isDashPath("/dashboard", "/dash")).toBe(false);
  });
});

describe("dashQueries", () => {
  it("uses the slug's dataset", () => {
    expect(datasetFor("perxel-demo")).toBe("mcp_perxel_demo");
  });

  it.each(Object.keys(DASH_RANGES) as DashRange[])("every %s query passes the proxy validator for its own dataset only", (range) => {
    const queries = dashQueries("mcp_perxel_demo", range);
    for (const [id, sql] of Object.entries(queries)) {
      expect(validateQuery(sql, "mcp_perxel_demo"), id).toEqual({ ok: true });
      expect(validateQuery(sql, "mcp_other").ok, id).toBe(false);
      expect(sql, id).toContain(`INTERVAL '${DASH_RANGES[range].hours}' HOUR`);
      expect(sql, id).toMatch(/FORMAT JSON$/);
      // AE has no uniq(); distinct counts use count(DISTINCT ...).
      expect(sql, id).not.toMatch(/\buniq\(/);
    }
  });
});

describe("checkDashAccess", () => {
  const req = (headers: Record<string, string> = {}) => new Request("https://mcp.perxel.com/dash/", { headers });

  it("lets localhost through for wrangler dev", async () => {
    const res = await checkDashAccess(new Request("http://localhost:8788/dash/"), {} as Env, NOW);
    expect(res).toEqual({ viewer: "" });
  });

  it("lets wrangler dev through when MCP_PUBLIC_URL is localhost (dev rewrites the host)", async () => {
    const env = { MCP_PUBLIC_URL: "http://localhost:8788", DASH_ACCESS_TEAM: TEAM, DASH_ACCESS_AUD: AUD } as unknown as Env;
    expect(await checkDashAccess(req(), env, NOW)).toEqual({ viewer: "" });
  });

  it("does not skip the check for a real public URL", async () => {
    const env = { MCP_PUBLIC_URL: "https://mcp.perxel.com", DASH_ACCESS_TEAM: TEAM, DASH_ACCESS_AUD: AUD } as unknown as Env;
    expect(((await checkDashAccess(req(), env, NOW)) as Response).status).toBe(403);
  });

  it("fails closed with 503 when Access isn't configured", async () => {
    const res = await checkDashAccess(req(), {} as Env, NOW);
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(503);
  });

  it("403s without an assertion", async () => {
    const env = { DASH_ACCESS_TEAM: TEAM, DASH_ACCESS_AUD: AUD } as unknown as Env;
    const res = await checkDashAccess(req(), env, NOW);
    expect((res as Response).status).toBe(403);
  });

  it("accepts a valid assertion and returns the email", async () => {
    const { jwk, sign } = await accessKeys();
    const token = await sign({ aud: [AUD], iss: `https://${TEAM}`, exp: NOW / 1000 + 600, email: "phuc@perxel.com" });
    const env = { DASH_ACCESS_TEAM: `https://${TEAM}/`, DASH_ACCESS_AUD: AUD } as unknown as Env;
    const { result, urls } = await withJwks(jwk, () => checkDashAccess(req({ "Cf-Access-Jwt-Assertion": token }), env, NOW));
    expect(result).toEqual({ viewer: "phuc@perxel.com" });
    expect(urls).toEqual([`https://${TEAM}/cdn-cgi/access/certs`]);
  });

  it.each([
    ["wrong audience", { aud: ["other"], iss: `https://${TEAM}`, exp: NOW / 1000 + 600 }],
    ["wrong issuer", { aud: [AUD], iss: "https://evil.cloudflareaccess.com", exp: NOW / 1000 + 600 }],
    ["expired", { aud: [AUD], iss: `https://${TEAM}`, exp: NOW / 1000 - 10 }],
    ["no expiry", { aud: [AUD], iss: `https://${TEAM}` }],
  ])("rejects %s", async (_name, claims) => {
    const { jwk, sign } = await accessKeys();
    const token = await sign(claims);
    const env = { DASH_ACCESS_TEAM: TEAM, DASH_ACCESS_AUD: AUD } as unknown as Env;
    const { result } = await withJwks(jwk, () => checkDashAccess(req({ "Cf-Access-Jwt-Assertion": token }), env, NOW));
    expect((result as Response).status).toBe(403);
  });

  it("rejects a token signed by another key", async () => {
    const good = await accessKeys();
    const other = await accessKeys();
    const token = await other.sign({ aud: [AUD], iss: `https://${TEAM}`, exp: NOW / 1000 + 600 });
    const env = { DASH_ACCESS_TEAM: TEAM, DASH_ACCESS_AUD: AUD } as unknown as Env;
    const { result } = await withJwks(good.jwk, () => checkDashAccess(req({ "Cf-Access-Jwt-Assertion": token }), env, NOW));
    expect((result as Response).status).toBe(403);
  });
});

/** A fake proxy service binding: records requests, answers by query shape. */
function fakeProxy(answer: (sql: string) => Response) {
  const seen: { auth: string | null; sql: string }[] = [];
  const binding = {
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      const sql = String(init?.body ?? "");
      seen.push({ auth: new Headers(init?.headers).get("authorization"), sql });
      return answer(sql);
    },
  };
  return { binding: binding as unknown as Fetcher, seen };
}

const local = (path: string, init?: RequestInit) => new Request(`http://localhost:8788${path}`, init);

describe("handleDash", () => {
  it("redirects the bare path to the trailing slash, keeping the query", async () => {
    const res = await handleDash(local("/dash?range=24h"), {} as Env, config, "/dash", noLog, NOW);
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/dash/?range=24h");
  });

  it("404s unknown sub-paths and 405s writes", async () => {
    expect((await handleDash(local("/dash/x"), {} as Env, config, "/dash", noLog, NOW)).status).toBe(404);
    expect((await handleDash(local("/dash/", { method: "POST" }), {} as Env, config, "/dash", noLog, NOW)).status).toBe(405);
  });

  it("renders an empty dashboard with a notice when no proxy is bound", async () => {
    const res = await handleDash(local("/dash/"), {} as Env, config, "/dash", noLog, NOW);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    const html = await res.text();
    expect(html).toContain("No metrics proxy bound");
    expect(html).toContain("Demo MCP");
  });

  it("queries the proxy with the key and renders the data, escaped", async () => {
    const { binding, seen } = fakeProxy((sql) => {
      if (sql.includes("count(DISTINCT index1)")) {
        return Response.json({ data: [{ calls: "120", not_ok: "6", rate_limited: "2", p95_ms: 88.4, callers: "9" }] });
      }
      if (sql.includes("blob3 AS status, sum")) {
        return Response.json({
          data: [
            { t: "2026-09-30 06:00:00", status: "ok", calls: "50" },
            { t: "2026-09-30 06:00:00", status: "error", calls: "4" },
          ],
        });
      }
      if (sql.includes("GROUP BY tool ORDER BY")) {
        return Response.json({
          data: [{ tool: "<script>x</script>", calls: "70", not_ok: "7", p50_ms: 12, p95_ms: 40, lists: "70", items: "210" }],
        });
      }
      if (sql.includes("blob5 AS k")) return Response.json({ data: [{ k: "claude-ai", calls: "100" }] });
      return Response.json({ data: [] });
    });
    const env = { METRICS_PROXY: binding, DASH_PROXY_KEY: "k-123" } as unknown as Env;
    const res = await handleDash(local("/dash/?range=24h"), env, config, "/dash", noLog, NOW);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(seen).toHaveLength(8);
    expect(seen.every((s) => s.auth === "Bearer k-123")).toBe(true);
    expect(seen.every((s) => s.sql.includes("FROM mcp_perxel_demo") && s.sql.includes("INTERVAL '24' HOUR"))).toBe(true);
    expect(html).toContain("120"); // calls tile
    expect(html).toContain("5.0%"); // 6 / 120
    expect(html).toContain("88 ms");
    expect(html).toContain("claude-ai");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("3.0"); // avg items 210 / 70
    expect(html).toMatch(/<rect class="s-ok"/);
    expect(html).toMatch(/<rect class="s-error"/);
  });

  it("falls back to 7d for an unknown range", async () => {
    const { binding, seen } = fakeProxy(() => Response.json({ data: [] }));
    const env = { METRICS_PROXY: binding, DASH_PROXY_KEY: "k" } as unknown as Env;
    await handleDash(local("/dash/?range=1y"), env, config, "/dash", noLog, NOW);
    expect(seen.every((s) => s.sql.includes("INTERVAL '168' HOUR"))).toBe(true);
  });

  it("shows a per-panel error when the proxy refuses", async () => {
    const { binding } = fakeProxy(() => Response.json({ error: "unauthorized" }, { status: 401 }));
    const env = { METRICS_PROXY: binding, DASH_PROXY_KEY: "wrong" } as unknown as Env;
    const html = await (await handleDash(local("/dash/"), env, config, "/dash", noLog, NOW)).text();
    expect(html).toContain("metrics proxy answered 401");
  });
});

describe("worker routing", () => {
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  const baseEnv = { MCP_PUBLIC_URL: "https://mcp.perxel.com" };

  it("serves the dashboard at /dash by default and fails closed on the public host", async () => {
    const worker = createWorker(config);
    const res = await worker.fetch(new Request("https://mcp.perxel.com/dash/"), baseEnv as unknown as Env, ctx);
    expect(res.status).toBe(503);
  });

  it("moves with DASH_PATH and is gone when off", async () => {
    const worker = createWorker(config);
    const moved = { ...baseEnv, DASH_PATH: "/ops" } as unknown as Env;
    expect((await worker.fetch(local("/ops/"), moved, ctx)).status).toBe(200);
    const off = { ...baseEnv, DASH_PATH: "off" } as unknown as Env;
    const res = await worker.fetch(local("/dash/"), off, ctx);
    expect(res.status).not.toBe(200);
  });
});
