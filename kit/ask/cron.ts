import { generateText } from "ai";
import type { McpConfig } from "../core/config.js";
import type { Env } from "../core/env.js";
import { askTopics, ASK_DEFAULTS } from "./config.js";
import { type AskDeps } from "./handler.js";
import { askModel, askProviderOptions, hasProviderKey, stepsCost } from "./model.js";
import { topicInstructions } from "./prompt.js";
import { addCost, applyRetention, getMessages, idleWithoutTopic, pruneQuota, setTopic } from "./store.js";
import { vietnamDate } from "../core/date.js";

export const TOPIC_BATCH = 50;
export const IDLE_MS = 60 * 60 * 1000;

/** The topic from a model answer: one of `topics`, else "other". */
export function normalizeTopic(answer: string, topics: string[]): string {
  const word = answer.trim().toLowerCase().replace(/^["'`]+|["'`.!]+$/g, "");
  return topics.includes(word) ? word : "other";
}

/**
 * The daily job (`scheduled`): label up to 50 idle conversations with a topic (visitor
 * messages only, one model call each), then delete text older than `retentionDays`.
 * Does nothing without `config.ask` or `ASK_DB`.
 */
export async function runAskCron(
  config: McpConfig,
  env: Env,
  deps: Pick<AskDeps, "modelFor" | "now"> = {},
  log: (event: string, fields?: Record<string, unknown>) => void = () => {},
): Promise<{ labelled: number; cleared: number }> {
  const ask = config.ask;
  const db = env.ASK_DB;
  if (!ask || !db) return { labelled: 0, cleared: 0 };
  const now = (deps.now ?? Date.now)();
  const topics = askTopics(ask);
  let labelled = 0;

  if (hasProviderKey(ask, env) || deps.modelFor) {
    const modelId = ask.summaryModel ?? ask.model;
    const model = (deps.modelFor ?? askModel)(modelId, ask, env);
    for (const convo of await idleWithoutTopic(db, now - IDLE_MS, TOPIC_BATCH)) {
      const visitor = (await getMessages(db, convo.id)).filter((m) => m.role === "user").map((m) => m.text);
      try {
        const result = await generateText({
          model,
          instructions: topicInstructions(topics),
          prompt: visitor.join("\n"),
          maxOutputTokens: 10,
          maxRetries: 1,
          ...(askProviderOptions(ask) ? { providerOptions: askProviderOptions(ask) } : {}),
        });
        await setTopic(db, convo.id, normalizeTopic(result.text, topics));
        const cost = stepsCost(ask, modelId, result.steps);
        if (cost > 0) await addCost(db, convo.id, cost);
        labelled++;
      } catch (err) {
        log("ask.topic_error", { message: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  const cleared = await applyRetention(db, ask.retentionDays ?? ASK_DEFAULTS.retentionDays, now);
  // Question counts are only read for today; keep yesterday's for a look in D1.
  await pruneQuota(db, vietnamDate(new Date(now - 86_400_000))).catch((err: unknown) =>
    log("ask.quota_prune_error", { message: err instanceof Error ? err.message : String(err) }),
  );
  log("ask.cron", { labelled, cleared });
  return { labelled, cleared };
}
