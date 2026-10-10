import type { Env } from "../core/env.js";
import { recordAskTurn, type AskTurnRow } from "../core/metrics.js";
import { appendTurn, markHandoff, type AppendTurnInput } from "./store.js";

/**
 * Where Ask records a turn. Production uses the Cloudflare sink (Analytics Engine row
 * + D1 conversation). Another sink (e.g. Langfuse for one client) implements the same
 * interface; none ships in production by default.
 */
export interface AskLogger {
  /** A refused or failed request: metrics only, no text. */
  refusal(row: AskTurnRow): void;
  /** An answered turn. `turn.user` must already be redacted. */
  turn(row: AskTurnRow, turn: AppendTurnInput, handoff: boolean): Promise<void>;
}

export function cloudflareAskLogger(env: Env, log: (event: string, fields?: Record<string, unknown>) => void): AskLogger {
  return {
    refusal(row) {
      recordAskTurn(env, row);
    },
    async turn(row, turn, handoff) {
      recordAskTurn(env, row);
      const db = env.ASK_DB;
      if (!db) return;
      try {
        await appendTurn(db, turn);
        if (handoff) await markHandoff(db, turn.id);
      } catch (err) {
        log("ask.store_error", { message: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}
