import { describe, expect, it } from "vitest";
import { defineConfig } from "./config.js";
import {
  DASH_RANGES,
  type DashRange,
  checkDashAccess,
  dashPathFor,
  dashQueries,
  askDashQueries,
  datasetFor,
  handleDash,
  isDashPath,
  renderDashPage,
} from "./dash.js";
import type { Env } from "./env.js";
import { createWorker } from "./worker.js";
import { validateQuery } from "../metrics-proxy/validate.js";
import { FakeD1 } from "../ask/testing/fake-d1.js";
import { appendTurn, askTopicCounts, askOutcomeCounts } from "../ask/store.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const migrationsSql = readFileSync(join(__dirname, "../ask/migrations/0001_init.sql"), "utf-8");

const config = defineConfig({
  slug: "my-demo",
  name: "Demo MCP",
  version: "1.2.3",
  description: "Test config.",
  scopes: {},
  tools: [],
  docs: { contact: "hello@example.com" },
});

const configWithAsk = defineConfig({
  slug: "my-demo",
  name: "Demo MCP",
  version: "1.2.3",
  description: "Test config.",
  scopes: {},
  tools: [],
  docs: { contact: "hello@example.com" },
  ask: {
    model: "test-model",
    systemPrompt: "Test prompt",
    allowedOrigins: ["https://example.com"],
    handoff: [{ label: "Contact", href: "/contact" }],
    topics: ["wordpress", "nextjs", "other"],
  },
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

const TEAM = "your-team.cloudflareaccess.com";
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
    expect(datasetFor("my-demo")).toBe("mcp_my_demo");
  });

  it.each(Object.keys(DASH_RANGES) as DashRange[])("every %s query passes the proxy validator for its own dataset only", (range) => {
    const queries = dashQueries("mcp_my_demo", range);
    for (const [id, sql] of Object.entries(queries)) {
      expect(validateQuery(sql, "mcp_my_demo"), id).toEqual({ ok: true });
      expect(validateQuery(sql, "mcp_other").ok, id).toBe(false);
      expect(sql, id).toContain(`INTERVAL '${DASH_RANGES[range].hours}' HOUR`);
      expect(sql, id).toMatch(/FORMAT JSON$/);
      // AE has no uniq(); distinct counts use count(DISTINCT ...).
      expect(sql, id).not.toMatch(/\buniq\(/);
    }
  });

  it("excludes ask.turn rows from all panels", () => {
    const queries = dashQueries("mcp_my_demo", "7d");
    for (const [id, sql] of Object.entries(queries)) {
      expect(sql, id).toContain("blob2 != 'ask.turn'");
    }
  });
});

describe("askDashQueries", () => {
  it("returns askTimeline and askCost queries for the dataset", () => {
    const queries = askDashQueries("mcp_my_demo", "7d");
    expect(queries.askTimeline).toContain("FROM mcp_my_demo");
    expect(queries.askTimeline).toContain("blob2 = 'ask.turn'");
    expect(queries.askTimeline).toContain("blob3 = 'ok'");
    expect(queries.askTimeline).toMatch(/FORMAT JSON$/);

    expect(queries.askCost).toContain("FROM mcp_my_demo");
    expect(queries.askCost).toContain("blob2 = 'ask.turn'");
    expect(queries.askCost).toContain("blob3 = 'ok'");
    expect(queries.askCost).toContain("sum(double3 * _sample_interval) / 1000000 AS usd");
    expect(queries.askCost).toMatch(/FORMAT JSON$/);
  });

  it("uses the correct range interval", () => {
    const queries = askDashQueries("mcp_my_demo", "24h");
    expect(queries.askTimeline).toContain("INTERVAL '24' HOUR");
    expect(queries.askCost).toContain("INTERVAL '24' HOUR");
  });
});

describe("checkDashAccess", () => {
  const req = (headers: Record<string, string> = {}) => new Request("https://mcp.example.com/dash/", { headers });

  it("lets localhost through for wrangler dev", async () => {
    const res = await checkDashAccess(new Request("http://localhost:8788/dash/"), {} as Env, NOW);
    expect(res).toEqual({ viewer: "" });
  });

  it("lets wrangler dev through when MCP_PUBLIC_URL is localhost (dev rewrites the host)", async () => {
    const env = { MCP_PUBLIC_URL: "http://localhost:8788", DASH_ACCESS_TEAM: TEAM, DASH_ACCESS_AUD: AUD } as unknown as Env;
    expect(await checkDashAccess(req(), env, NOW)).toEqual({ viewer: "" });
  });

  it("does not skip the check for a real public URL", async () => {
    const env = { MCP_PUBLIC_URL: "https://mcp.example.com", DASH_ACCESS_TEAM: TEAM, DASH_ACCESS_AUD: AUD } as unknown as Env;
    expect(((await checkDashAccess(req(), env, NOW)) as Response).status).toBe(403);
  });

  it("serves without a sign-in only when DASH_PUBLIC is exactly \"true\"", async () => {
    const base = { MCP_PUBLIC_URL: "https://mcp.example.com" };
    expect(await checkDashAccess(req(), { ...base, DASH_PUBLIC: "true" } as unknown as Env, NOW)).toEqual({ viewer: "" });
    for (const v of ["false", "", "1", "TRUE"]) {
      expect(((await checkDashAccess(req(), { ...base, DASH_PUBLIC: v } as unknown as Env, NOW)) as Response).status).toBe(503);
    }
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
    const token = await sign({ aud: [AUD], iss: `https://${TEAM}`, exp: NOW / 1000 + 600, email: "viewer@example.com" });
    const env = { DASH_ACCESS_TEAM: `https://${TEAM}/`, DASH_ACCESS_AUD: AUD } as unknown as Env;
    const { result, urls } = await withJwks(jwk, () => checkDashAccess(req({ "Cf-Access-Jwt-Assertion": token }), env, NOW));
    expect(result).toEqual({ viewer: "viewer@example.com" });
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
    expect(seen.every((s) => s.sql.includes("FROM mcp_my_demo") && s.sql.includes("INTERVAL '24' HOUR"))).toBe(true);
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

  it("does not render Ask section when config.ask is not set", async () => {
    const { binding } = fakeProxy(() => Response.json({ data: [] }));
    const env = { METRICS_PROXY: binding, DASH_PROXY_KEY: "k", DASH_PUBLIC: "true" } as unknown as Env;
    const html = await (await handleDash(local("/dash/"), env, config, "/dash", noLog, NOW)).text();
    expect(html).not.toContain("Ask turns per bucket");
    expect(html).not.toContain("Ask cost trend");
    expect(html).not.toContain("Outcomes");
    expect(html).not.toContain("Top topics");
  });

  it("renders Ask section when config.ask is set and DASH_PUBLIC=true", async () => {
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
          data: [{ tool: "search_content", calls: "70", not_ok: "7", p50_ms: 12, p95_ms: 40, lists: "70", items: "210" }],
        });
      }
      if (sql.includes("blob5 AS k")) return Response.json({ data: [{ k: "claude-ai", calls: "100" }] });
      if (sql.includes("blob2 = 'ask.turn'") && sql.includes("calls")) {
        return Response.json({ data: [{ t: "2026-09-30 06:00:00", calls: "25" }] });
      }
      if (sql.includes("blob2 = 'ask.turn'") && sql.includes("usd")) {
        return Response.json({ data: [{ t: "2026-09-30 06:00:00", usd: "0.42" }] });
      }
      return Response.json({ data: [] });
    });
    const env = { METRICS_PROXY: binding, DASH_PROXY_KEY: "k", DASH_PUBLIC: "true" } as unknown as Env;
    const html = await (await handleDash(local("/dash/"), env, configWithAsk, "/dash", noLog, NOW)).text();
    expect(html).toContain("Ask turns per bucket");
    expect(html).toContain("Ask cost trend (USD)");
    expect(html).toContain("Outcomes");
    expect(html).toContain("Top topics");
    expect(seen.some((s) => s.sql.includes("blob2 = 'ask.turn'") && s.sql.includes("calls"))).toBe(true);
    expect(seen.some((s) => s.sql.includes("blob2 = 'ask.turn'") && s.sql.includes("usd"))).toBe(true);
  });
});

describe("renderDashPage Ask section", () => {
  it("includes Ask section when config.ask is set and askPanels provided", () => {
    const html = renderDashPage({
      config: configWithAsk,
      dashPath: "/dash",
      range: "7d",
      now: NOW,
      viewer: null,
      notice: null,
      panels: {},
      askPanels: {
        askTimeline: { rows: [{ t: "2026-09-30 06:00:00", calls: "10" }] },
        askCost: { rows: [{ t: "2026-09-30 06:00:00", usd: "0.5" }] },
      },
      askTopicCounts: [{ topic: "wordpress", n: 5 }, { topic: "unlabelled", n: 3 }],
      askOutcomeCounts: { answered: 7, handedOff: 2, leads: 1 },
    });
    expect(html).toContain("Ask turns per bucket");
    expect(html).toContain("Ask cost trend (USD)");
    expect(html).toContain("Outcomes");
    expect(html).toContain("Top topics");
    expect(html).toContain("wordpress");
    expect(html).toContain("unlabelled");
    expect(html).toContain("Answered");
    expect(html).toContain("Handed off");
    expect(html).toContain("Leads");
  });

  it("does not include Ask section when config.ask is not set", () => {
    const html = renderDashPage({
      config: config,
      dashPath: "/dash",
      range: "7d",
      now: NOW,
      viewer: null,
      notice: null,
      panels: {},
      askPanels: {
        askTimeline: { rows: [{ t: "2026-09-30 06:00:00", calls: "10" }] },
        askCost: { rows: [{ t: "2026-09-30 06:00:00", usd: "0.5" }] },
      },
      askTopicCounts: [{ topic: "wordpress", n: 5 }],
      askOutcomeCounts: { answered: 7, handedOff: 2, leads: 1 },
    });
    expect(html).not.toContain("Ask turns per bucket");
    expect(html).not.toContain("Ask cost trend");
    expect(html).not.toContain("Outcomes");
    expect(html).not.toContain("Top topics");
  });
});

describe("Ask store functions with FakeD1", () => {
  it("askTopicCounts returns topic counts with unlabelled for NULL topic", async () => {
    const db = new FakeD1(migrationsSql) as unknown as D1Database;
    const now = Date.now();
    const sinceMs = now - 86400000;

    await appendTurn(db, {
      id: "conv-1",
      now,
      locale: "vi",
      page: "/",
      country: "VN",
      callerKey: "ip:1.2.3.4",
      model: "test",
      user: "Question 1",
      assistant: "Answer 1",
      tools: [],
      tokensIn: 10,
      tokensOut: 20,
      costUsd: 0.001,
      cited: [],
    });
    await appendTurn(db, {
      id: "conv-2",
      now,
      locale: "en",
      page: "/en",
      country: "US",
      callerKey: "ip:5.6.7.8",
      model: "test",
      user: "Question 2",
      assistant: "Answer 2",
      tools: [],
      tokensIn: 10,
      tokensOut: 20,
      costUsd: 0.001,
      cited: [],
    });
    await appendTurn(db, {
      id: "conv-3",
      now,
      locale: "vi",
      page: "/",
      country: "VN",
      callerKey: "ip:1.2.3.4",
      model: "test",
      user: "Question 3",
      assistant: "Answer 3",
      tools: [],
      tokensIn: 10,
      tokensOut: 20,
      costUsd: 0.001,
      cited: [],
    });

    // Set topics for conv-1 and conv-3
    await db.prepare("UPDATE conversations SET topic = 'wordpress' WHERE id = 'conv-1'").run();
    await db.prepare("UPDATE conversations SET topic = 'nextjs' WHERE id = 'conv-3'").run();
    // conv-2 has no topic (NULL)

    const counts = await askTopicCounts(db, sinceMs);
    expect(counts).toEqual([
      { topic: "wordpress", n: 1 },
      { topic: "nextjs", n: 1 },
      { topic: "unlabelled", n: 1 },
    ]);
  });

  it("askOutcomeCounts returns answered, handedOff, leads counts", async () => {
    const db = new FakeD1(migrationsSql) as unknown as D1Database;
    const now = Date.now();
    const sinceMs = now - 86400000;

    await appendTurn(db, {
      id: "conv-answered",
      now,
      locale: "vi",
      page: "/",
      country: "VN",
      callerKey: "ip:1.2.3.4",
      model: "test",
      user: "Question",
      assistant: "Answer",
      tools: [],
      tokensIn: 10,
      tokensOut: 20,
      costUsd: 0.001,
      cited: [],
    });
    await appendTurn(db, {
      id: "conv-handed-off",
      now,
      locale: "vi",
      page: "/",
      country: "VN",
      callerKey: "ip:1.2.3.4",
      model: "test",
      user: "Question",
      assistant: "Answer",
      tools: [],
      tokensIn: 10,
      tokensOut: 20,
      costUsd: 0.001,
      cited: [],
    });
    await appendTurn(db, {
      id: "conv-lead",
      now,
      locale: "vi",
      page: "/",
      country: "VN",
      callerKey: "ip:1.2.3.4",
      model: "test",
      user: "Question",
      assistant: "Answer",
      tools: [],
      tokensIn: 10,
      tokensOut: 20,
      costUsd: 0.001,
      cited: [],
    });

    await db.prepare("UPDATE conversations SET handoff = 1 WHERE id = 'conv-handed-off'").run();
    await db.prepare("UPDATE conversations SET lead_sent = 1 WHERE id = 'conv-lead'").run();

    const counts = await askOutcomeCounts(db, sinceMs);
    expect(counts).toEqual({ answered: 1, handedOff: 1, leads: 1 });
  });
});

describe("handleDash with Ask D1 data", () => {
  it("renders Ask section with topic counts but no secret text or conversation id when DASH_PUBLIC=true and ASK_DB seeded", async () => {
    const db = new FakeD1(migrationsSql) as unknown as D1Database;
    const now = NOW;
    const sinceMs = now - DASH_RANGES["7d"].hours * 3_600_000;

    await appendTurn(db, {
      id: "secret-conv-id-123",
      now,
      locale: "vi",
      page: "/",
      country: "VN",
      callerKey: "ip:1.2.3.4",
      model: "test-model",
      user: "SECRET-QUESTION-TEXT",
      assistant: "SECRET-ANSWER",
      tools: [{ name: "search_content", slug: "search_content" }],
      tokensIn: 50,
      tokensOut: 100,
      costUsd: 0.002,
      cited: ["https://perxel.com/services"],
    });
    await db.prepare("UPDATE conversations SET topic = 'wordpress' WHERE id = 'secret-conv-id-123'").run();

    const { binding, seen } = fakeProxy((sql) => {
      if (sql.includes("count(DISTINCT index1)")) {
        return Response.json({ data: [{ calls: "120", not_ok: "6", rate_limited: "2", p95_ms: 88.4, callers: "9" }] });
      }
      if (sql.includes("blob3 AS status, sum")) {
        return Response.json({ data: [{ t: "2026-09-30 06:00:00", status: "ok", calls: "50" }] });
      }
      if (sql.includes("GROUP BY tool ORDER BY")) {
        return Response.json({ data: [{ tool: "search_content", calls: "70", not_ok: "7", p50_ms: 12, p95_ms: 40, lists: "70", items: "210" }] });
      }
      if (sql.includes("blob5 AS k")) return Response.json({ data: [{ k: "claude-ai", calls: "100" }] });
      if (sql.includes("blob2 = 'ask.turn'") && sql.includes("calls")) {
        return Response.json({ data: [{ t: "2026-09-30 06:00:00", calls: "1" }] });
      }
      if (sql.includes("blob2 = 'ask.turn'") && sql.includes("usd")) {
        return Response.json({ data: [{ t: "2026-09-30 06:00:00", usd: "0.002" }] });
      }
      return Response.json({ data: [] });
    });

    const env = {
      METRICS_PROXY: binding,
      DASH_PROXY_KEY: "k",
      DASH_PUBLIC: "true",
      ASK_DB: db,
    } as unknown as Env;

    const html = await (await handleDash(local("/dash/"), env, configWithAsk, "/dash", noLog, NOW)).text();

    // Should contain topic counts
    expect(html).toContain("wordpress");
    // Should NOT contain secret question text
    expect(html).not.toContain("SECRET-QUESTION-TEXT");
    // Should NOT contain secret answer text
    expect(html).not.toContain("SECRET-ANSWER");
    // Should NOT contain conversation id
    expect(html).not.toContain("secret-conv-id-123");
    // Should contain Ask section headers
    expect(html).toContain("Ask turns per bucket");
    expect(html).toContain("Ask cost trend (USD)");
    expect(html).toContain("Outcomes");
    expect(html).toContain("Top topics");
  });
});

describe("worker routing", () => {
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  const baseEnv = { MCP_PUBLIC_URL: "https://mcp.example.com" };

  it("serves the dashboard at /dash by default and fails closed on the public host", async () => {
    const worker = createWorker(config);
    const res = await worker.fetch(new Request("https://mcp.example.com/dash/"), baseEnv as unknown as Env, ctx);
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
