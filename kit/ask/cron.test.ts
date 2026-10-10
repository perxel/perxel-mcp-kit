import { readFileSync } from "node:fs";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import type { McpConfig } from "../core/config.js";
import type { Env } from "../core/env.js";
import { normalizeTopic, runAskCron } from "./cron.js";
import { appendTurn, getConversation, getMessages } from "./store.js";
import { FakeD1 } from "./testing/fake-d1.js";

const config: McpConfig = {
  slug: "example",
  name: "E",
  version: "1",
  description: "d",
  scopes: {},
  tools: [],
  docs: { contact: "c" },
  ask: {
    model: "m",
    systemPrompt: "x",
    allowedOrigins: ["https://example.com"],
    handoff: [],
    topics: ["pricing", "wordpress"],
    retentionDays: 90,
  },
};

const DAY = 86_400_000;

function model(answer: string) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: answer }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
      warnings: [],
      providerMetadata: { openrouter: { usage: { cost: 0.001 } } },
    }),
  });
}

async function seed(db: D1Database, id: string, at: number) {
  await appendTurn(db, {
    id, now: at, locale: "vi", page: "/", country: "VN", callerKey: "ip:x", model: "m",
    user: "Giá WordPress?", assistant: "Từ 20.000.000đ.", tools: [], tokensIn: 1, tokensOut: 1, costUsd: 0, cited: [],
  });
}

describe("ask cron", () => {
  it("normalizes model answers to the topic list", () => {
    expect(normalizeTopic(" Pricing. ", ["pricing", "other"])).toBe("pricing");
    expect(normalizeTopic("something else", ["pricing", "other"])).toBe("other");
  });

  it("labels idle conversations and clears old text", async () => {
    const db = new FakeD1(readFileSync("kit/ask/migrations/0001_init.sql", "utf8")) as unknown as D1Database;
    const now = 200 * DAY;
    await seed(db, "old", now - 100 * DAY);
    await seed(db, "idle", now - 2 * 60 * 60 * 1000);
    await seed(db, "fresh", now - 60 * 1000);
    const env = { ASK_DB: db } as unknown as Env;
    const res = await runAskCron(config, env, { modelFor: () => model("pricing"), now: () => now });
    expect(res).toEqual({ labelled: 2, cleared: 1 });
    expect((await getConversation(db, "idle"))?.topic).toBe("pricing");
    expect((await getConversation(db, "fresh"))?.topic).toBeNull();
    const old = await getConversation(db, "old");
    expect(old?.caller_key).toBeNull();
    expect(old?.text_deleted_at).toBe(now);
    expect(await getMessages(db, "old")).toEqual([]);
  });

  it("does nothing without an ask block or a database", async () => {
    expect(await runAskCron({ ...config, ask: undefined } as McpConfig, {} as Env)).toEqual({ labelled: 0, cleared: 0 });
  });
});
