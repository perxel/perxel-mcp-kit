import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel, LanguageModelUsage } from "ai";
import type { Env } from "../core/env.js";
import type { AskConfig, AskPricing } from "./config.js";

/**
 * The model behind Ask: OpenRouter (default) or Anthropic's API directly (`ask.provider:
 * "anthropic"`). OpenRouter reports each call's cost; Anthropic doesn't, so the cost is
 * computed from the token usage and a price per million tokens (`ANTHROPIC_PRICES`, or
 * `ask.pricing` for a model not in it).
 */

/**
 * Anthropic list prices in USD per million tokens (checked 2026-11-22; only published
 * values, the rest fall back as in `usageCost`). Haiku 5.5 costs more beyond 100K prompt
 * tokens ($0.50 / $2.50), which Ask doesn't reach (history is capped by
 * `messagesPerConversation`). Update with a kit release.
 */
export const ANTHROPIC_PRICES: Readonly<Record<string, AskPricing>> = {
  "claude-haiku-5-5": { inputPerMTok: 0.1, outputPerMTok: 0.5 },
  "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.1 },
  "claude-opus-5-5": { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2 },
};

/** The prices for `modelId`: the config's when set, else the kit table; null when neither knows it. */
export function pricingFor(ask: AskConfig, modelId: string): AskPricing | null {
  return ask.pricing?.[modelId] ?? ANTHROPIC_PRICES[modelId] ?? null;
}

/**
 * USD for one call's usage at `p`. Without a given price, cache reads count at the input
 * price and cache writes at 1.25x it (the 5-minute rate), so spend is over- rather than
 * under-counted.
 */
export function usageCost(usage: Pick<LanguageModelUsage, "inputTokens" | "inputTokenDetails" | "outputTokens">, p: AskPricing): number {
  const read = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const write = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  const plain = usage.inputTokenDetails?.noCacheTokens ?? Math.max(0, (usage.inputTokens ?? 0) - read - write);
  const out = usage.outputTokens ?? 0;
  return (
    (plain * p.inputPerMTok +
      read * (p.cacheReadPerMTok ?? p.inputPerMTok) +
      write * (p.cacheWritePerMTok ?? p.inputPerMTok * 1.25) +
      out * p.outputPerMTok) /
    1_000_000
  );
}

interface CostedStep {
  providerMetadata?: unknown;
  usage?: Pick<LanguageModelUsage, "inputTokens" | "inputTokenDetails" | "outputTokens">;
  response?: { modelId?: string };
}

/**
 * The USD cost of a call's steps: OpenRouter's reported cost when present, else the
 * usage priced for the step's model (falling back to `modelId`). 0 only when the usage is 0.
 */
export function stepsCost(ask: AskConfig, modelId: string, steps: readonly CostedStep[]): number {
  let usd = 0;
  for (const s of steps) {
    const reported = (s.providerMetadata as { openrouter?: { usage?: { cost?: unknown } } } | undefined)?.openrouter?.usage?.cost;
    if (typeof reported === "number" && Number.isFinite(reported)) {
      usd += reported;
      continue;
    }
    if ((ask.provider ?? "openrouter") !== "anthropic" || !s.usage) continue;
    const p = pricingFor(ask, s.response?.modelId ?? modelId) ?? pricingFor(ask, modelId);
    if (p) usd += usageCost(s.usage, p);
  }
  return usd;
}

/** The env secret the configured provider needs. */
export function providerKeyName(ask: AskConfig): "OPENROUTER_API_KEY" | "ANTHROPIC_API_KEY" {
  return ask.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENROUTER_API_KEY";
}

/** True when the provider's key is set. */
export function hasProviderKey(ask: AskConfig, env: Env): boolean {
  return Boolean(env[providerKeyName(ask)]);
}

/** OpenRouter with the plan's settings: no providers that store prompts, cost in usage, fallbacks. */
export function openRouterModel(id: string, ask: AskConfig, env: Env): LanguageModel {
  const openrouter = createOpenRouter({ apiKey: env.OPENROUTER_API_KEY as string });
  return openrouter(id, {
    ...(ask.fallbackModels?.length ? { models: ask.fallbackModels } : {}),
    usage: { include: true },
    provider: { data_collection: "deny" },
  });
}

/** Anthropic's API directly (API inputs are not used for training by default). */
export function anthropicModel(id: string, _ask: AskConfig, env: Env): LanguageModel {
  return createAnthropic({ apiKey: env.ANTHROPIC_API_KEY as string })(id);
}

/** The model for `id` on the configured provider. */
export function askModel(id: string, ask: AskConfig, env: Env): LanguageModel {
  return ask.provider === "anthropic" ? anthropicModel(id, ask, env) : openRouterModel(id, ask, env);
}

/** Per-call provider options: Anthropic's effort when set. */
export function askProviderOptions(ask: AskConfig): { anthropic: { effort: NonNullable<AskConfig["effort"]> } } | undefined {
  return ask.provider === "anthropic" && ask.effort ? { anthropic: { effort: ask.effort } } : undefined;
}
