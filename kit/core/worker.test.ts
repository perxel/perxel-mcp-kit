import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineConfig } from "./config.js";
import type { Env } from "./env.js";
import { recordToolCall } from "./metrics.js";
import { defineTool, ToolError } from "./tool.js";
import { createWorker, type SourceStatus } from "./worker.js";
import exampleConfig from "../../mcp.config.js";

const okTool = defineTool({
  name: "ok_tool",
  title: "OK",
  description: "Always works, returns 3 items.",
  access: "public",
  inputSchema: z.object({}),
  async execute() {
    return { data: { items: [1, 2, 3] }, count: 3 };
  },
});

const badTool = defineTool({
  name: "bad_tool",
  title: "Bad",
  description: "Always throws bad_input.",
  access: "public",
  inputSchema: z.object({}),
  async execute() {
    throw new ToolError("bad_input", "nope");
  },
});

const boomTool = defineTool({
  name: "boom_tool",
  title: "Boom",
  description: "Always throws upstream.",
  access: "public",
  inputSchema: z.object({}),
  async execute() {
    throw new ToolError("upstream", "kaboom");
  },
});

const config = defineConfig({
  slug: "example",
  name: "Example MCP",
  version: "0.1.0",
  description: "Test config.",
  scopes: {},
  tools: [okTool, badTool, boomTool],
  docs: { contact: "hello@perxel.com" },
});

interface FakeAE {
  points: AnalyticsEngineDataPoint[];
}

function fakeEnv(overrides: Record<string, unknown> = {}): { env: Env; points: AnalyticsEngineDataPoint[]; rateKeys: string[]; anthropicKeys: string[] } {
  const points: AnalyticsEngineDataPoint[] = [];
  const rateKeys: string[] = [];
  const anthropicKeys: string[] = [];
  const env = {
    MCP_PUBLIC_URL: "https://mcp.perxel.com",
    IP_HASH_SALT: "test-salt",
    METRICS: { writeDataPoint: (p?: AnalyticsEngineDataPoint) => void points.push(p!) },
    RATE_LIMITER: {
      limit: async ({ key }: { key: string }) => {
        rateKeys.push(key);
        return { success: true };
      },
    },
    RATE_LIMITER_ANTHROPIC: {
      limit: async ({ key }: { key: string }) => {
        anthropicKeys.push(key);
        return { success: true };
      },
    },
    ...overrides,
  } as unknown as Env;
  return { env, points, rateKeys, anthropicKeys };
}

function fakeCtx() {
  const waited: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void waited.push(p),
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return { ctx, waited };
}

async function callTool(
  worker: ReturnType<typeof createWorker>,
  env: Env,
  ctx: ExecutionContext,
  name: string,
  ip = "1.2.3.4",
) {
  const res = await worker.fetch(
    new Request("https://mcp.perxel.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "CF-Connecting-IP": ip,
        "user-agent": "test-agent",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: {} } }),
    }),
    env,
    ctx,
  );
  // Legacy stateless serving answers SSE even for a single result.
  const text = await res.text();
  const dataLine = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("data:"));
  return { res, json: JSON.parse(dataLine ? dataLine.slice("data:".length).trim() : text) as Record<string, unknown> };
}

describe("metrics rows", () => {
  it("records ok with the full 3.6 row", async () => {
    const worker = createWorker(config);
    const { env, points } = fakeEnv();
    const { ctx, waited } = fakeCtx();
    const { res, json } = await callTool(worker, env, ctx, "ok_tool");
    expect(res.status).toBe(200);
    expect((json["result"] as Record<string, unknown>)["isError"]).toBeUndefined();
    await Promise.all(waited);
    expect(points).toHaveLength(1);
    const p = points[0];
    expect(p.indexes?.[0]).toMatch(/^ip:[0-9a-f]{16}$/);
    expect(p.blobs).toEqual([
      "example",
      "ok_tool",
      "ok",
      "",
      "other",
      "public",
      "anon",
      "",
      "legacy",
      "dev",
    ]);
    expect(p.doubles?.[0]).toBeGreaterThanOrEqual(0);
    expect(p.doubles?.[1]).toBe(3);
    expect(p.doubles?.[2]).toBeGreaterThan(0);
  });

  it("records invalid_input for ToolError bad_input", async () => {
    const worker = createWorker(config);
    const { env, points } = fakeEnv();
    const { ctx, waited } = fakeCtx();
    const { json } = await callTool(worker, env, ctx, "bad_tool");
    expect((json["result"] as Record<string, unknown>)["isError"]).toBe(true);
    await Promise.all(waited);
    expect(points).toHaveLength(1);
    expect(points[0].blobs?.[2]).toBe("invalid_input");
    expect(points[0].blobs?.[3]).toBe("bad_input");
    expect(points[0].doubles?.[1]).toBe(-1);
  });

  it("records error for ToolError upstream", async () => {
    const worker = createWorker(config);
    const { env, points } = fakeEnv();
    const { ctx, waited } = fakeCtx();
    await callTool(worker, env, ctx, "boom_tool");
    await Promise.all(waited);
    expect(points).toHaveLength(1);
    expect(points[0].blobs?.[2]).toBe("error");
    expect(points[0].blobs?.[3]).toBe("upstream");
  });

  it("records unknown tools as error/unknown", async () => {
    const worker = createWorker(config);
    const { env, points } = fakeEnv();
    const { ctx, waited } = fakeCtx();
    await callTool(worker, env, ctx, "nope_tool");
    await Promise.all(waited);
    expect(points).toHaveLength(1);
    expect(points[0].blobs?.[1]).toBe("unknown");
    expect(points[0].blobs?.[2]).toBe("error");
  });

  it("recordToolCall never throws without a METRICS binding", () => {
    expect(() =>
      recordToolCall({} as Env, {
        callerKey: "",
        slug: "example",
        tool: "ok_tool",
        status: "ok",
        code: "",
        client: "other",
        access: "public",
        auth: "anon",
        country: "",
        era: "legacy",
        latencyMs: 1,
        count: 1,
        bytes: 10,
      }),
    ).not.toThrow();
  });
});

describe("rate limit", () => {
  it("429s with Retry-After and a JSON-RPC body, plus a rate_limited row", async () => {
    const worker = createWorker(config);
    const { env, points, rateKeys } = fakeEnv({
      RATE_LIMITER: { limit: async ({ key }: { key: string }) => { rateKeys.push(key); return { success: false }; } },
    });
    const { ctx, waited } = fakeCtx();
    const { res, json } = await callTool(worker, env, ctx, "ok_tool");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(json).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32000, message: "Rate limit exceeded, retry in a minute" },
    });
    expect(rateKeys).toHaveLength(1);
    await Promise.all(waited);
    expect(points).toHaveLength(1);
    expect(points[0].blobs?.[2]).toBe("rate_limited");
    expect(points[0].blobs?.[1]).toBe("ok_tool");
  });

  it("uses the shared Anthropic bucket inside 160.79.104.0/21", async () => {
    const worker = createWorker(config);
    const { env, rateKeys, anthropicKeys } = fakeEnv();
    const { ctx } = fakeCtx();
    await callTool(worker, env, ctx, "ok_tool", "160.79.104.5");
    expect(anthropicKeys).toEqual(["anthropic"]);
    expect(rateKeys).toHaveLength(0);
  });

  it("uses the per-IP bucket outside the Anthropic range", async () => {
    const worker = createWorker(config);
    const { env, rateKeys, anthropicKeys } = fakeEnv();
    const { ctx } = fakeCtx();
    await callTool(worker, env, ctx, "ok_tool", "8.8.8.8");
    expect(rateKeys).toHaveLength(1);
    expect(rateKeys[0]).toMatch(/^ip:[0-9a-f]{16}$/);
    expect(anthropicKeys).toHaveLength(0);
  });
});

describe("/health", () => {
  it("returns the 3.7 shape with empty sources", async () => {
    const worker = createWorker(config);
    const { env } = fakeEnv();
    const { ctx } = fakeCtx();
    const res = await worker.fetch(new Request("https://mcp.perxel.com/health"), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      name: "Example MCP",
      slug: "example",
      version: "0.1.0",
      kit: "dev",
      sources: {},
    });
  });

  it("503s when a required source is empty", async () => {
    const worker = createWorker(config, {
      sources: { content: { from: "empty", fetchedAt: "", etag: "", items: 0 } },
    });
    const { env } = fakeEnv();
    const { ctx } = fakeCtx();
    const res = await worker.fetch(new Request("https://mcp.perxel.com/health"), env, ctx);
    expect(res.status).toBe(503);
    expect(((await res.json()) as Record<string, unknown>)["ok"]).toBe(false);
  });

  it("loads a live source before reporting it (a fresh isolate isn't 'empty')", async () => {
    let loads = 0;
    let status: SourceStatus = { from: "empty", fetchedAt: "", etag: "", items: 0 };
    const live = {
      get: async () => {
        loads += 1;
        status = { from: "kv-fallback", fetchedAt: "2026-09-30T00:00:00.000Z", etag: '"x"', items: 4 };
        return {};
      },
      status: () => status,
    };
    const worker = createWorker(config, { sources: { content: live } });
    const { env } = fakeEnv();
    const { ctx } = fakeCtx();
    const res = await worker.fetch(new Request("https://mcp.perxel.com/health"), env, ctx);
    expect(loads).toBe(1);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { sources: Record<string, SourceStatus> }).sources.content.from).toBe("kv-fallback");
  });

  it("503s when a live source can't load at all", async () => {
    const live = {
      get: async () => {
        throw new Error("down");
      },
      status: (): SourceStatus => ({ from: "empty", fetchedAt: "", etag: "", items: 0 }),
    };
    const worker = createWorker(config, { sources: { content: live } });
    const { env } = fakeEnv();
    const { ctx } = fakeCtx();
    const res = await worker.fetch(new Request("https://mcp.perxel.com/health"), env, ctx);
    expect(res.status).toBe(503);
  });
});

describe("docs page", () => {
  it("contains every tool name of the example config", async () => {
    const worker = createWorker(exampleConfig);
    const { env } = fakeEnv();
    const { ctx } = fakeCtx();
    const res = await worker.fetch(new Request("https://mcp.perxel.com/"), env, ctx);
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const tool of exampleConfig.tools) {
      expect(html).toContain(tool.name);
    }
    expect(html).toContain("https://mcp.perxel.com/mcp");
    expect(html).toContain("Add custom connector");
  });
});
