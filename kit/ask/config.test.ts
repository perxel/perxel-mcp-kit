import { describe, expect, it } from "vitest";
import { defineConfig, type McpConfig } from "../core/config.js";
import { askLimits, askTopics, clientPromptFor, type AskConfig } from "./config.js";

function ask(overrides: Partial<AskConfig> = {}): AskConfig {
  return {
    model: "vendor/model",
    systemPrompt: { vi: "Xin chào", en: "Hello" },
    allowedOrigins: ["https://example.com"],
    handoff: [{ label: "Contact", href: "https://example.com/contact" }],
    topics: ["pricing", "process"],
    ...overrides,
  };
}

function config(a: AskConfig | undefined): McpConfig {
  return {
    slug: "example",
    name: "Example",
    version: "0.1.0",
    description: "Example.",
    scopes: {},
    tools: [],
    docs: { contact: "hi@example.com" },
    ...(a ? { ask: a } : {}),
  };
}

describe("ask config", () => {
  it("accepts a valid block and a config without one", () => {
    expect(() => defineConfig(config(ask()))).not.toThrow();
    expect(() => defineConfig(config(undefined))).not.toThrow();
    expect(() => defineConfig(config(ask({ allowedOrigins: ["http://localhost:3000"] })))).not.toThrow();
    expect(() => defineConfig(config(ask({ actions: ["lead", "subscribe"] })))).not.toThrow();
    expect(() => defineConfig(config(ask({ provider: "anthropic", model: "claude-haiku-5-5", effort: "low" })))).not.toThrow();
    expect(() =>
      defineConfig(config(ask({ provider: "anthropic", model: "claude-new", pricing: { "claude-new": { inputPerMTok: 1, outputPerMTok: 2 } } }))),
    ).not.toThrow();
    expect(() => defineConfig(config(ask({ limits: { questionsPerVisitorPerDay: 5, questionsPerIpPerDay: 20 } })))).not.toThrow();
  });

  it.each([
    ["empty model", { model: " " }],
    ["no origins", { allowedOrigins: [] }],
    ["http origin", { allowedOrigins: ["http://example.com"] }],
    ["origin with path", { allowedOrigins: ["https://example.com/"] }],
    ["wildcard origin", { allowedOrigins: ["https://*.example.com"] }],
    ["no topics", { topics: [] }],
    ["duplicate topics", { topics: ["a", "a"] }],
    ["bad topic", { topics: ["Has Space"] }],
    ["zero retention", { retentionDays: 0 }],
    ["zero session hours", { sessionHours: 0 }],
    ["negative limit", { limits: { maxInputChars: -1 } }],
    ["NaN limit", { limits: { dailyBudgetUsd: Number.NaN } }],
    ["half prompt", { systemPrompt: { vi: "x" } as unknown as AskConfig["systemPrompt"] }],
    ["unknown action", { actions: ["call"] as unknown as AskConfig["actions"] }],
    ["duplicate action", { actions: ["lead", "lead"] }],
    ["bad handoff locale", { handoff: [{ label: "x", href: "y", locale: "fr" as "vi" }] }],
    ["unknown provider", { provider: "openai" as "anthropic" }],
    ["Anthropic model with no price", { provider: "anthropic", model: "claude-new" }],
    ["Anthropic summary model with no price", { provider: "anthropic", model: "claude-haiku-5-5", summaryModel: "claude-new" }],
    ["fallback models on Anthropic", { provider: "anthropic", model: "claude-haiku-5-5", fallbackModels: ["claude-sonnet-5-5"] }],
    ["effort on OpenRouter", { effort: "low" }],
    ["unknown effort", { provider: "anthropic", model: "claude-haiku-5-5", effort: "huge" as "low" }],
    ["half a price", { provider: "anthropic", model: "x", pricing: { x: { inputPerMTok: 1 } as never } }],
    ["negative price", { provider: "anthropic", model: "x", pricing: { x: { inputPerMTok: -1, outputPerMTok: 1 } } }],
    ["zero question limit", { limits: { questionsPerVisitorPerDay: 0 } }],
    ["unknown rules", { rules: "strict" as "own" }],
  ])("rejects %s", (_name, o) => {
    expect(() => defineConfig(config(ask(o as Partial<AskConfig>)))).toThrow(/ask\./);
  });

  it("fills limit defaults and adds the other topic once", () => {
    expect(askLimits(ask())).toEqual({
      messagesPerConversation: 20,
      maxInputChars: 1000,
      maxOutputTokens: 700,
      maxToolSteps: 4,
      perIpPerMinute: 6,
      questionsPerVisitorPerDay: null,
      questionsPerIpPerDay: null,
      dailyBudgetUsd: 3,
    });
    expect(askLimits(ask({ limits: { maxToolSteps: 2 } })).maxToolSteps).toBe(2);
    expect(askTopics(ask())).toEqual(["pricing", "process", "other"]);
    expect(askTopics(ask({ topics: ["other", "x"] }))).toEqual(["other", "x"]);
  });

  it("picks the prompt for a locale", () => {
    expect(clientPromptFor(ask(), "en")).toBe("Hello");
    expect(clientPromptFor(ask({ systemPrompt: "Same" }), "vi")).toBe("Same");
  });
});
