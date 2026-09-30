import type { Env } from "./env.js";
import { KIT_VERSION } from "./version.js";

export type MetricStatus = "ok" | "error" | "invalid_input" | "unauthorized" | "forbidden" | "rate_limited";

export interface MetricRow {
  callerKey: string; // "u:…" / "ip:…" / ""
  slug: string;
  tool: string; // "unknown" when the tool name wasn't found
  status: MetricStatus;
  code: string; // error code or ""
  client: "claude-ai" | "claude-code" | "inspector" | "other";
  access: "public" | "private";
  auth: "anon" | "user";
  country: string;
  era: "modern" | "legacy";
  latencyMs: number;
  count: number; // result count, -1 when not a list
  bytes: number; // response bytes, -1 when unknown
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
