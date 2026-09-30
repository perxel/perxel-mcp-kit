import { describe, expect, it } from "vitest";
import type { Env } from "../core/env.js";
import { createWorker } from "../core/worker.js";
// The clone's own config: this test runs against whatever the clone defines.
import config from "../../mcp.config.js";

const worker = createWorker(config);

function testEnv() {
  const points: AnalyticsEngineDataPoint[] = [];
  const env = {
    MCP_PUBLIC_URL: "http://localhost:8788",
    IP_HASH_SALT: "test-salt",
    METRICS: { writeDataPoint: (p?: AnalyticsEngineDataPoint) => void points.push(p!) },
    RATE_LIMITER: { limit: async () => ({ success: true }) },
    RATE_LIMITER_ANTHROPIC: { limit: async () => ({ success: true }) },
  } as unknown as Env;
  const waited: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void waited.push(p),
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return { env, ctx };
}

/** POST one JSON-RPC message the way a 2025-era client does; parses the SSE answer. */
async function rpc(method: string, params: Record<string, unknown>, id: number = 1) {
  const res = await worker.fetch(
    new Request("http://localhost:8788/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "CF-Connecting-IP": "1.2.3.4",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    }),
    testEnv().env,
    testEnv().ctx,
  );
  expect(res.status).toBe(200);
  const text = await res.text();
  const dataLine = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("data:"));
  return JSON.parse(dataLine!.slice("data:".length).trim()) as {
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
  };
}

interface JsonSchema {
  type?: string;
  properties?: Record<string, { type?: string }>;
}

/** A wrong-typed value for the first typed property, or null when no property qualifies. */
function badArguments(schema: JsonSchema): Record<string, unknown> | null {
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (prop.type === "string") return { [key]: 123 };
    if (prop.type === "number" || prop.type === "integer") return { [key]: "not-a-number" };
    if (prop.type === "boolean") return { [key]: "not-a-boolean" };
    if (prop.type === "array") return { [key]: "not-an-array" };
    if (prop.type === "object") return { [key]: 42 };
  }
  return null;
}

describe("protocol", () => {
  it("tools/list matches the config and every input schema is an object", async () => {
    const msg = await rpc("tools/list", {});
    const tools = msg.result?.["tools"] as { name: string; inputSchema: JsonSchema }[];
    expect(tools.map((t) => t.name).sort()).toEqual(config.tools.map((t) => t.name).sort());
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("a bad argument returns isError: true (without running the tool)", async () => {
    const listed = (await rpc("tools/list", {})).result?.["tools"] as {
      name: string;
      inputSchema: JsonSchema;
    }[];
    let exercised = 0;
    for (const tool of listed) {
      const args = badArguments(tool.inputSchema);
      if (!args) continue;
      const msg = await rpc("tools/call", { name: tool.name, arguments: args });
      expect(msg.result?.["isError"]).toBe(true);
      exercised += 1;
    }
    // Guards against a vacuous pass if no tool takes typed input.
    expect(exercised).toBeGreaterThan(0);
  });

  it("a 2025-era client (initialize then tools/list) works", async () => {
    const init = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "protocol-test", version: "0.1.0" },
    });
    expect(init.result?.["protocolVersion"]).toBe("2025-06-18");
    expect((init.result?.["serverInfo"] as { name: string }).name).toBe(config.slug);
    const list = await rpc("tools/list", {});
    const tools = list.result?.["tools"] as { name: string }[];
    expect(tools.map((t) => t.name).sort()).toEqual(config.tools.map((t) => t.name).sort());
  });

  describe.skipIf(!config.tools.some((t) => t.name === "get_time"))("example tools", () => {
    it("get_time call works", async () => {
      const msg = await rpc("tools/call", { name: "get_time", arguments: { timezone: "UTC" } });
      expect(msg.result?.["isError"]).toBeUndefined();
      const content = msg.result?.["content"] as { type: string; text: string }[];
      expect(JSON.parse(content[0].text)).toMatchObject({ timezone: "UTC" });
    });
  });
});
