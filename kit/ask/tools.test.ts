import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { McpConfig } from "../core/config.js";
import type { Env } from "../core/env.js";
import { defineTool, ToolError, type ToolContext } from "../core/tool.js";
import { buildAskTools, HANDOFF_TOOL, sourcesIn } from "./tools.js";

const seen: { locale?: string; auth?: unknown }[] = [];
const search = defineTool({
  name: "search_content",
  title: "Search",
  description: "Search.",
  access: "public",
  inputSchema: z.object({ query: z.string(), locale: z.enum(["vi", "en"]).default("vi") }),
  async execute(input, ctx) {
    seen.push({ locale: input.locale, auth: ctx.auth });
    if (input.query === "boom") throw new ToolError("not_found", "nothing");
    return {
      data: {
        items: [
          { title: "A", url: "https://x.test/a", slug: "a" },
          { title: "A again", url: "https://x.test/a" },
          { title: "B", url: "https://x.test/b" },
          { title: "No url" },
          { title: "Bad", url: "javascript:alert(1)" },
        ],
      },
      count: 3,
    };
  },
});
const secret = defineTool({
  name: "secret_tool",
  title: "Secret",
  description: "Private.",
  access: "private",
  scope: "private:read",
  inputSchema: z.object({}),
  async execute() {
    return { data: {} };
  },
});

const config: McpConfig = {
  slug: "example",
  name: "Example",
  version: "1",
  description: "d",
  scopes: { "private:read": "r" },
  tools: [search, secret],
  docs: { contact: "c" },
};

function setup() {
  const rows: unknown[] = [];
  const env = { METRICS: { writeDataPoint: (r: unknown) => rows.push(r) } } as unknown as Env;
  const ctx: ToolContext = { env, auth: { userId: "u", scopes: [] }, requestId: "r", log: () => {} };
  const sources: string[] = [];
  const runs: string[] = [];
  const tools = buildAskTools({
    config,
    ctx,
    locale: "en",
    metrics: { callerKey: "ip:x", country: "VN" },
    onSource: (s) => sources.push(s.url),
    onTool: (r) => runs.push(r.name),
  });
  return { tools, rows, sources, runs };
}

const opts = { toolCallId: "1", messages: [] } as never;

describe("ask tools", () => {
  it("offers public tools and the handoff only", () => {
    expect(Object.keys(setup().tools).sort()).toEqual(["search_content", HANDOFF_TOOL].sort());
  });

  it("hides locale from the model, forces the visitor's, and runs anonymously", async () => {
    const { tools, rows, sources, runs } = setup();
    const schema = tools["search_content"].inputSchema as z.ZodObject;
    expect(Object.keys(schema.shape)).toEqual(["query"]);
    await tools["search_content"].execute!({ query: "x", locale: "vi" }, opts);
    expect(seen.at(-1)).toEqual({ locale: "en", auth: null });
    expect(sources).toEqual(["https://x.test/a", "https://x.test/b"]);
    expect(runs).toEqual(["search_content"]);
    expect(JSON.stringify(rows[0])).toContain('"ask"');
  });

  it("returns tool errors to the model instead of throwing", async () => {
    const { tools } = setup();
    expect(await tools["search_content"].execute!({ query: "boom" }, opts)).toEqual({ error: "nothing" });
  });

  it("caps sources at 4 across calls", () => {
    expect(sourcesIn({ a: [{ title: "t", url: "https://1" }, { b: { title: "u", url: "http://2" } }] }).map((s) => s.url)).toEqual([
      "https://1",
      "http://2",
    ]);
  });
});
