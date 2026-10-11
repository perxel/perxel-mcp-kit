import type { Env } from "./env.js";
import { KIT_VERSION } from "./version.js";

export type MetricStatus = "ok" | "error" | "invalid_input" | "unauthorized" | "forbidden" | "rate_limited";

export interface MetricRow {
  callerKey: string; // "u:…" / "ip:…" / ""
  slug: string;
  tool: string; // "unknown" when the tool name wasn't found
  status: MetricStatus;
  code: string; // error code or ""
  client: "claude-ai" | "claude-code" | "inspector" | "other" | "ask"; // "ask": tool calls made by the Ask chat
  access: "public" | "private";
  auth: "anon" | "user";
  country: string;
  era: "modern" | "legacy";
  latencyMs: number;
  count: number; // result count, -1 when not a list
  bytes: number; // response bytes, -1 when unknown. For `ask.turn` rows: cost in micro-USD.
}

/**
 * Ask writes one extra row per turn with `tool: "ask.turn"`, `client: "ask"`: `status`
 * "ok" or "error" with the Ask error code in `code`. Doubles keep the tool-row layout:
 * double1 latencyMs (request to last token), double2 tool calls in the turn, double3 (the
 * `bytes` slot) cost in micro-USD, plus double4 output tokens, double5 ms to the first
 * answer text (-1: none), double6 ms of checks before the model call, double7 model steps
 * (0 on refusals and on rows written before these fields), double8 ms waiting on the model,
 * double9 ms in tools. Dashboard tool-call panels exclude these rows.
 */
export const ASK_TURN_TOOL = "ask.turn";

export interface AskTurnRow {
  callerKey: string;
  slug: string;
  status: "ok" | "error" | "rate_limited";
  code: string;
  country: string;
  latencyMs: number;
  toolCalls: number;
  costMicroUsd: number;
  tokensOut: number;
  /** Request start to the first answer text, -1 when no text was sent. */
  firstTextMs?: number;
  /** Request start to the model call: every check and read before it. */
  preModelMs?: number;
  /** Model calls in the turn (each tool round is one more). */
  modelSteps?: number;
  /** Time waiting on the model, all steps. */
  modelMs?: number;
  /** Time running tools, all steps. */
  toolMs?: number;
}

export function recordAskTurn(env: Env, row: AskTurnRow): void {
  const analytics = env.METRICS;
  if (!analytics) return;
  try {
    analytics.writeDataPoint({
      indexes: [row.callerKey],
      blobs: [row.slug, ASK_TURN_TOOL, row.status, row.code, "ask", "public", "anon", row.country, "modern", KIT_VERSION],
      doubles: [
        row.latencyMs,
        row.toolCalls,
        row.costMicroUsd,
        row.tokensOut,
        row.firstTextMs ?? -1,
        row.preModelMs ?? -1,
        row.modelSteps ?? 0,
        row.modelMs ?? -1,
        row.toolMs ?? -1,
      ],
    });
  } catch {
    // Never fail the answer over metrics.
  }
}

/**
 * One row per `tools/call` (section 3.6). Never throws and never fails the
 * request: no tool arguments, emails, raw IPs, user ids, or tokens in the row.
 */
export function recordToolCall(env: Env, row: MetricRow): void {
  const analytics = env.METRICS;
  if (!analytics) return;
  try {
    analytics.writeDataPoint({
      indexes: [row.callerKey],
      blobs: [
        row.slug,
        row.tool,
        row.status,
        row.code,
        row.client,
        row.access,
        row.auth,
        row.country,
        row.era,
        KIT_VERSION,
      ],
      doubles: [row.latencyMs, row.count, row.bytes],
    });
  } catch {
    // A metrics failure must never fail the tool call.
  }
}
