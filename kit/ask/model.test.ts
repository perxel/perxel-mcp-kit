import { describe, expect, it } from "vitest";
import type { Env } from "../core/env.js";
import { KNOWN_ANTHROPIC_MODELS, type AskConfig } from "./config.js";
import { ANTHROPIC_PRICES, askProviderOptions, hasProviderKey, pricingFor, providerKeyName, stepsCost, usageCost } from "./model.js";

const base: AskConfig = { model: "claude-haiku-5-5", systemPrompt: "x", allowedOrigins: ["https://example.com"], handoff: [], topics: ["a"] };
const anthropic: AskConfig = { ...base, provider: "anthropic" };

const usage = (input: number, output: number, read = 0, write = 0) => ({
  inputTokens: input + read + write,
  inputTokenDetails: { noCacheTokens: input, cacheReadTokens: read, cacheWriteTokens: write },
  outputTokens: output,
});

describe("Ask model and cost", () => {
  it("the kit's known model list matches its price table", () => {
    expect([...KNOWN_ANTHROPIC_MODELS].sort()).toEqual(Object.keys(ANTHROPIC_PRICES).sort());
  });

  it("prices usage per million tokens, cache reads at the input price and writes at 1.25x when not given", () => {
    const p = { inputPerMTok: 1, outputPerMTok: 5 };
    expect(usageCost(usage(1_000_000, 0), p)).toBeCloseTo(1);
    expect(usageCost(usage(0, 1_000_000), p)).toBeCloseTo(5);
    expect(usageCost(usage(0, 0, 1_000_000), p)).toBeCloseTo(1);
    expect(usageCost(usage(0, 0, 0, 1_000_000), p)).toBeCloseTo(1.25);
    expect(usageCost(usage(0, 0, 1_000_000), { ...p, cacheReadPerMTok: 0.1 })).toBeCloseTo(0.1);
  });

  it("Haiku 5.5: 2,000 tokens in and 300 out cost $0.00035", () => {
    expect(usageCost(usage(2000, 300), ANTHROPIC_PRICES["claude-haiku-5-5"]!)).toBeCloseTo(0.00035, 8);
  });

  it("the config's price wins over the kit's", () => {
    const own = { inputPerMTok: 9, outputPerMTok: 9 };
    expect(pricingFor({ ...anthropic, pricing: { "claude-haiku-5-5": own } }, "claude-haiku-5-5")).toBe(own);
    expect(pricingFor(anthropic, "claude-unknown")).toBeNull();
  });

  it("uses OpenRouter's reported cost, and prices Anthropic steps from usage", () => {
    const or = [{ providerMetadata: { openrouter: { usage: { cost: 0.002 } } }, usage: usage(1000, 1000) }];
    expect(stepsCost(base, "vendor/model", or)).toBe(0.002);
    // OpenRouter without a reported cost: not priced (the provider is not Anthropic).
    expect(stepsCost(base, "claude-haiku-5-5", [{ usage: usage(1_000_000, 0) }])).toBe(0);
    const steps = [{ usage: usage(1_000_000, 0) }, { usage: usage(0, 1_000_000), response: { modelId: "claude-sonnet-5-5" } }];
    expect(stepsCost(anthropic, "claude-haiku-5-5", steps)).toBeCloseTo(0.1 + 10);
  });

  it("names the provider's key and its effort option", () => {
    expect(providerKeyName(base)).toBe("OPENROUTER_API_KEY");
    expect(providerKeyName(anthropic)).toBe("ANTHROPIC_API_KEY");
    expect(hasProviderKey(anthropic, { OPENROUTER_API_KEY: "k" } as unknown as Env)).toBe(false);
    expect(hasProviderKey(anthropic, { ANTHROPIC_API_KEY: "k" } as unknown as Env)).toBe(true);
    expect(askProviderOptions(anthropic)).toBeUndefined();
    expect(askProviderOptions({ ...anthropic, effort: "low" })).toEqual({ anthropic: { effort: "low" } });
  });
});
