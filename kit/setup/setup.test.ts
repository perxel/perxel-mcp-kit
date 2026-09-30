import { describe, expect, it } from "vitest";
import type { CfApi } from "./cf-api.js";
import {
  isPlaceholder,
  mergeProxyKeys,
  oidcUrls,
  parseDotVars,
  pickNamespaceIds,
  readMcpConfig,
  setJsonValue,
  setKvId,
  stripJsonc,
} from "./setup.js";

const WRANGLER = `{
  // comment with a url https://example.com/x
  "name": "demo-mcp",
  "routes": [{ "pattern": "mcp.demo.com", "custom_domain": true }],
  "vars": {
    "MCP_PUBLIC_URL": "https://mcp.demo.com", /* block */
    "DASH_ACCESS_TEAM": "<paste: team>",
    "DASH_ACCESS_AUD": "<paste: aud>",
  },
  "kv_namespaces": [
    { "binding": "OAUTH_KV", "id": "<run: create>" },
    { "binding": "CONTENT_KV", "id": "abc123" },
  ],
  "analytics_engine_datasets": [{ "binding": "METRICS", "dataset": "mcp_demo" }],
  "ratelimits": [
    { "name": "A", "namespace_id": "1001", "simple": { "limit": 60, "period": 60 } },
    { "name": "B", "namespace_id": "1002", "simple": { "limit": 600, "period": 60 } }
  ]
}`;

describe("stripJsonc", () => {
  it("keeps urls inside strings and drops comments and trailing commas", () => {
    const parsed = JSON.parse(stripJsonc(WRANGLER));
    expect(parsed.vars.MCP_PUBLIC_URL).toBe("https://mcp.demo.com");
    expect(parsed.kv_namespaces).toHaveLength(2);
  });
});

describe("readMcpConfig", () => {
  it("reads name, host, dataset, kv ids, team, aud and rate-limit ids", () => {
    expect(readMcpConfig(WRANGLER)).toEqual({
      workerName: "demo-mcp",
      host: "mcp.demo.com",
      dataset: "mcp_demo",
      oauthKvId: "<run: create>",
      contentKvId: "abc123",
      team: "<paste: team>",
      aud: "<paste: aud>",
      namespaceIds: ["1001", "1002"],
    });
  });
  it("rejects a config without a route or dataset", () => {
    expect(() => readMcpConfig('{"name":"x"}')).toThrow(/routes pattern/);
  });
});

describe("config edits", () => {
  it("sets a var, a kv id and the nth namespace id without touching comments", () => {
    let t = setJsonValue(WRANGLER, "DASH_ACCESS_TEAM", "demo.cloudflareaccess.com");
    t = setKvId(t, "OAUTH_KV", "kv-1");
    t = setJsonValue(t, "namespace_id", "3002", 1);
    const c = readMcpConfig(t);
    expect(c.team).toBe("demo.cloudflareaccess.com");
    expect(c.oauthKvId).toBe("kv-1");
    expect(c.contentKvId).toBe("abc123");
    expect(c.namespaceIds).toEqual(["1001", "3002"]);
    expect(t).toContain("// comment with a url https://example.com/x");
  });
  it("detects placeholders", () => {
    expect(isPlaceholder("<paste: x>")).toBe(true);
    expect(isPlaceholder("")).toBe(true);
    expect(isPlaceholder("real")).toBe(false);
  });
});

describe("pickNamespaceIds", () => {
  it("keeps free ids", () => expect(pickNamespaceIds(["3001", "3002"], new Set(["1"]))).toEqual(["3001", "3002"]));
  it("moves to the next free pair on a collision", () =>
    expect(pickNamespaceIds(["3001", "3002"], new Set(["3001", "3002", "3003"]))).toEqual(["3004", "3005"]));
  it("replaces the starter ids only when they collide", () =>
    expect(pickNamespaceIds(["1001", "1002"], new Set(["1001"]))).toEqual(["3001", "3002"]));
});

describe("mergeProxyKeys", () => {
  it("adds an entry and keeps the others", () => {
    expect(mergeProxyKeys({ h1: "mcp_a" }, "h2", "mcp_b")).toEqual({ h1: "mcp_a", h2: "mcp_b" });
  });
  it("replaces the old key of the same dataset", () => {
    expect(mergeProxyKeys({ h1: "mcp_a", h2: "mcp_b" }, "h3", "mcp_a")).toEqual({ h2: "mcp_b", h3: "mcp_a" });
  });
});

describe("misc", () => {
  it("builds the oidc urls from team and client id", () => {
    expect(oidcUrls("t.cloudflareaccess.com", "cid")).toEqual({
      tokenUrl: "https://t.cloudflareaccess.com/cdn-cgi/access/sso/oidc/cid/token",
      authorizationUrl: "https://t.cloudflareaccess.com/cdn-cgi/access/sso/oidc/cid/authorization",
      jwksUrl: "https://t.cloudflareaccess.com/cdn-cgi/access/sso/oidc/cid/jwks",
    });
  });
  it("parses .dev.vars lines", () => {
    expect(parseDotVars('A="1"\n# c\nB=2\nC=""')).toEqual({ A: "1", B: "2", C: "" });
  });
});

// A recording fake that answers the reads runSetup makes.
function fakeApi(routes: Record<string, unknown>, calls: string[]): CfApi {
  return {
    async request<T>(method: string, path: string): Promise<T> {
      calls.push(`${method} ${path}`);
      const key = `${method} ${path}`;
      if (!(key in routes)) throw new Error(`unexpected ${key}`);
      return routes[key] as T;
    },
    async requestText() {
      return null;
    },
  };
}

describe("runSetup (dry run)", () => {
  it("reads first and writes nothing", async () => {
    const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { runSetup } = await import("./setup.js");
    const root = mkdtempSync(join(tmpdir(), "setup-"));
    writeFileSync(join(root, "wrangler.mcp.jsonc"), WRANGLER);
    const calls: string[] = [];
    const logs: string[] = [];
    const acc = "/accounts/A1";
    const api = fakeApi(
      {
        "GET /accounts": [{ id: "A1", name: "Acme" }],
        [`GET ${acc}/access/organizations`]: { auth_domain: "acme.cloudflareaccess.com" },
        [`GET ${acc}/access/policies`]: [],
        [`GET ${acc}/access/apps`]: [],
        [`GET ${acc}/storage/kv/namespaces?per_page=100`]: [],
        [`GET ${acc}/workers/scripts`]: [{ id: "other-mcp" }],
        [`GET ${acc}/workers/scripts/other-mcp/settings`]: { bindings: [{ type: "ratelimit", namespace_id: "1001" }] },
        [`GET ${acc}/workers/scripts/demo-mcp/secrets`]: [],
      },
      calls,
    );
    await runSetup({
      root,
      email: "me@x.com",
      emails: ["me@x.com"],
      policyName: "MCP access",
      dryRun: true,
      deploy: true,
      api,
      wrangler: { run: () => { throw new Error("wrangler must not run in a dry run"); } },
      log: (m) => logs.push(m),
    });
    expect(calls.every((c) => c.startsWith("GET"))).toBe(true);
    expect(readFileSync(join(root, "wrangler.mcp.jsonc"), "utf8")).toBe(WRANGLER);
    expect(logs.join("\n")).toMatch(/\[dry-run\] would create the OIDC sign-in app/);
    expect(logs.join("\n")).toMatch(/\[dry-run\] would create the dashboard app for mcp.demo.com\/dash/);
    expect(logs.join("\n")).toMatch(/3001, 3002 \(updated in config\)/);
  });
});
