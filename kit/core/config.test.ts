import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineConfig } from "./config.js";
import { defineTool, ToolError } from "./tool.js";

const publicTool = defineTool({
  name: "get_time",
  title: "Get time",
  description: "Current time.",
  access: "public",
  inputSchema: z.object({}),
  async execute() {
    return { data: {} };
  },
});

function privateTool(name: string, scope?: string) {
  return defineTool({
    name,
    title: name,
    description: "Private.",
    access: "private",
    ...(scope === undefined ? {} : { scope }),
    inputSchema: z.object({}),
    async execute() {
      return { data: {} };
    },
  });
}

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    slug: "example",
    name: "Example MCP",
    version: "0.1.0",
    description: "Example.",
    scopes: { "private:read": "Read private example data" },
    tools: [publicTool],
    docs: { contact: "hello@perxel.com" },
    ...overrides,
  } as Parameters<typeof defineConfig>[0];
}

describe("defineConfig", () => {
  it("accepts a valid config", () => {
    expect(() => defineConfig(baseConfig())).not.toThrow();
  });

  it("rejects a bad slug", () => {
    expect(() => defineConfig(baseConfig({ slug: "Bad_slug!" }))).toThrow(/slug/);
  });

  it("rejects duplicate tool names", () => {
    expect(() =>
      defineConfig(baseConfig({ tools: [publicTool, publicTool] })),
    ).toThrow(/duplicate tool name "get_time"/);
  });

  it("rejects a private tool without a scope", () => {
    expect(() => defineConfig(baseConfig({ tools: [privateTool("whoami")] }))).toThrow(
      /must declare a scope/,
    );
  });

  it("rejects a private tool whose scope is not listed", () => {
    expect(() =>
      defineConfig(baseConfig({ tools: [privateTool("whoami", "other:read")] })),
    ).toThrow(/not listed in config\.scopes/);
  });

  it("accepts a private tool with a listed scope", () => {
    expect(() =>
      defineConfig(baseConfig({ tools: [publicTool, privateTool("whoami", "private:read")] })),
    ).not.toThrow();
  });
});

describe("ToolError", () => {
  it("carries its code", () => {
    expect(new ToolError("not_found", "missing").code).toBe("not_found");
  });
});
