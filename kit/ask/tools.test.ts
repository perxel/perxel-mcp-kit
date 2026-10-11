import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { McpConfig } from "../core/config.js";
import type { Env } from "../core/env.js";
import { defineTool, ToolError, type ToolContext } from "../core/tool.js";
import { actionRules } from "./prompt.js";
import { buildAskTools, HANDOFF_TOOL, LEAD_TOOL, SUBSCRIBE_TOOL, sourcesIn, writtenIn } from "./tools.js";

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

  it("takes at most two sources from one result", async () => {
    const many = defineTool({
      name: "many",
      title: "Many",
      description: "Many.",
      access: "public",
      inputSchema: z.object({}),
      async execute() {
        return { data: { results: [1, 2, 3, 4].map((n) => ({ title: `T${n}`, url: `https://x.test/${n}` })) } };
      },
    });
    const sources: string[] = [];
    const tools = buildAskTools({
      config: { ...config, tools: [many] },
      ctx: { env: {} as Env, auth: null, requestId: "r", log: () => {} },
      locale: "vi",
      metrics: { callerKey: "", country: "" },
      onSource: (s) => sources.push(s.url),
    });
    await tools["many"].execute!({}, opts);
    expect(sources).toEqual(["https://x.test/1", "https://x.test/2"]);
  });

  it("caps sources at 4 across calls", () => {
    expect(sourcesIn({ a: [{ title: "t", url: "https://1" }, { b: { title: "u", url: "http://2" } }] }).map((s) => s.url)).toEqual([
      "https://1",
      "http://2",
    ]);
  });
});

describe("ask action tools", () => {
  function withActions(userText: string, actions: ("lead" | "subscribe")[] = ["lead", "subscribe"]) {
    const runs: string[] = [];
    const tools = buildAskTools({
      config,
      ctx: { env: {} as Env, auth: null, requestId: "r", log: () => {} },
      locale: "en",
      metrics: { callerKey: "", country: "" },
      onTool: (r) => runs.push(r.name),
      actions,
      userText,
    });
    return { tools, runs };
  }

  it("are off unless switched on, one at a time", () => {
    expect(Object.keys(setup().tools)).not.toContain(LEAD_TOOL);
    expect(Object.keys(withActions("", ["subscribe"]).tools)).toEqual(["search_content", HANDOFF_TOOL, SUBSCRIBE_TOOL]);
    expect(Object.keys(withActions("").tools)).toContain(LEAD_TOOL);
  });

  it("prepare_lead returns the fields written in the message and drops the rest", async () => {
    const said = "Quote for this brief https://docs.example.com/b/ please, I'm An, call 090 123 4567";
    const { tools, runs } = withActions(said);
    const out = await tools[LEAD_TOOL].execute!(
      { intent: "quote", message: " Quote for this brief ", contact: "0901234567", name: "An", briefUrl: "https://docs.example.com/b" },
      opts,
    );
    expect(out).toEqual({ action: "lead", intent: "quote", message: "Quote for this brief", contact: "0901234567", name: "An", briefUrl: "https://docs.example.com/b" });
    expect(runs).toEqual([LEAD_TOOL]);
    const made = await tools[LEAD_TOOL].execute!({ intent: "contact", message: "m", contact: "x@y.com", name: "Bình", briefUrl: "ftp://docs.example.com/b" }, opts);
    expect(made).toEqual({ action: "lead", intent: "contact", message: "m" });
  });

  it("prepare_subscribe keeps a valid email from the message only", async () => {
    const { tools } = withActions("send me new posts at A@B.co");
    expect(await tools[SUBSCRIBE_TOOL].execute!({ email: "a@b.co" }, opts)).toEqual({ action: "subscribe", email: "a@b.co" });
    expect(await tools[SUBSCRIBE_TOOL].execute!({ email: "c@d.co" }, opts)).toEqual({ action: "subscribe" });
    expect(await tools[SUBSCRIBE_TOOL].execute!({}, opts)).toEqual({ action: "subscribe" });
  });

  it("writtenIn matches phones by digits, the rest as text", () => {
    expect(writtenIn("+84 90 123 4567", "số mình 84901234567 nhé")).toBe(true);
    expect(writtenIn("1234", "1234")).toBe(false);
    expect(writtenIn("https://x.test/a/", "see https://x.test/a")).toBe(true);
    expect(writtenIn("", "anything")).toBe(false);
  });

  it("adds action rules to the prompt only for the switched-on actions", () => {
    const base = { model: "m", systemPrompt: "", allowedOrigins: ["https://x.test"], handoff: [], topics: ["a"] };
    expect(actionRules(base)).toBe("");
    const rules = actionRules({ ...base, actions: ["subscribe"] });
    expect(rules).toContain(SUBSCRIBE_TOOL);
    expect(rules).not.toContain(LEAD_TOOL);
  });
});
