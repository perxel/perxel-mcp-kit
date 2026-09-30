import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type MetricsProxyEnv } from "./worker.js";

const DS = "mcp_example";
const KEY = "dash-key-for-tests";
const KEY_HEX = createHash("sha256").update(KEY).digest("hex");

function env(): MetricsProxyEnv {
  return {
    CF_API_TOKEN: "real-token",
    CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    PROXY_KEYS: JSON.stringify({ [KEY_HEX]: DS }),
  };
}

const QUERY = `SELECT blob2 FROM ${DS} WHERE $timeFilter`;

function get(query: string, init?: RequestInit): Request {
  return new Request(`https://proxy.test/?query=${encodeURIComponent(query)}`, { method: "GET", ...init });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("metrics proxy auth", () => {
  it("rejects a missing key with 401", async () => {
    const res = await worker.fetch(get(QUERY), env());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects a wrong key with the same 401 (no oracle)", async () => {
    const res = await worker.fetch(
      get(QUERY, { headers: { Authorization: "Bearer wrong-key" } }),
      env(),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("accepts the key as a basic-auth password", async () => {
    const upstream = vi.fn(async (): Promise<Response> => new Response('{"data":[]}', { status: 200 }));
    vi.stubGlobal("fetch", upstream);
    const basic = Buffer.from(`grafana:${KEY}`).toString("base64");
    const res = await worker.fetch(get(QUERY, { headers: { Authorization: `Basic ${basic}` } }), env());
    expect(res.status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
  });
});

describe("metrics proxy forwarding", () => {
  function authed(init?: RequestInit): RequestInit {
    return { ...init, headers: { ...init?.headers, Authorization: `Bearer ${KEY}` } };
  }

  it("forwards an allowed GET query with the real token and passes the body through", async () => {
    const upstream = vi.fn(
      async (_url: string, _init?: RequestInit): Promise<Response> =>
        new Response('{"data":[{"tool":"get_time"}]}', { status: 200 }),
    );
    vi.stubGlobal("fetch", upstream);
    const res = await worker.fetch(get(QUERY, authed()), env());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"data":[{"tool":"get_time"}]}');
    expect(upstream).toHaveBeenCalledOnce();
    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/analytics_engine/sql",
    );
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer real-token");
    expect(init?.body).toBe(QUERY);
  });

  it("accepts a raw SQL POST body", async () => {
    const upstream = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", upstream);
    const res = await worker.fetch(
      new Request("https://proxy.test/", { method: "POST", body: QUERY, ...authed() }),
      env(),
    );
    expect(res.status).toBe(200);
    expect(upstream.mock.calls[0][1]?.body).toBe(QUERY);
  });

  it("accepts a JSON POST body with a query field", async () => {
    const upstream = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", upstream);
    const res = await worker.fetch(
      new Request("https://proxy.test/", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ query: QUERY }),
      }),
      env(),
    );
    expect(res.status).toBe(200);
    expect(upstream.mock.calls[0][1]?.body).toBe(QUERY);
  });

  it("rejects another dataset with 403 and never calls upstream", async () => {
    const upstream = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => new Response("must not happen", { status: 200 }));
    vi.stubGlobal("fetch", upstream);
    const res = await worker.fetch(
      get(`SELECT blob2 FROM mcp_khatra WHERE $timeFilter`, authed()),
      env(),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "query_rejected", reason: "dataset_forbidden" });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects UNION, subquery and two-statement exfiltration attempts", async () => {
    const upstream = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => new Response("must not happen", { status: 200 }));
    vi.stubGlobal("fetch", upstream);
    const e = env();
    for (const q of [
      `SELECT blob2 FROM ${DS} WHERE $timeFilter UNION ALL SELECT blob2 FROM mcp_other`,
      `SELECT * FROM (SELECT blob2 FROM mcp_other)`,
      `SELECT blob2 FROM ${DS}; SELECT blob2 FROM mcp_other`,
      "SHOW TABLES",
    ]) {
      expect((await worker.fetch(get(q, authed()), e)).status).toBe(403);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects a missing query with 400", async () => {
    const res = await worker.fetch(new Request("https://proxy.test/", authed()), env());
    expect(res.status).toBe(400);
  });

  it("rejects other methods with 405", async () => {
    const res = await worker.fetch(new Request("https://proxy.test/", { method: "DELETE", ...authed() }), env());
    expect(res.status).toBe(405);
  });

  it("returns 500 when secrets are missing", async () => {
    const noToken = env();
    delete (noToken as Record<string, unknown>).CF_API_TOKEN;
    expect((await worker.fetch(get(QUERY, authed()), noToken)).status).toBe(500);
    const badKeys = { ...env(), PROXY_KEYS: "not-json" };
    expect((await worker.fetch(get(QUERY, authed()), badKeys)).status).toBe(500);
  });
});
