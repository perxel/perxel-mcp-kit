/**
 * Ask conversation store (D1, the `ASK_DB` binding).
 *
 * Every query is a prepared statement with bound parameters. Values are never
 * interpolated into SQL strings.
 */

export interface ConversationRow {
  id: string;
  started_at: number;
  last_at: number;
  locale: string;
  page: string | null;
  country: string | null;
  caller_key: string | null;
  turns: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  model: string | null;
  topic: string | null;
  handoff: number;
  lead_sent: number;
  cited: string | null;
  text_deleted_at: number | null;
}

export interface MessageRow {
  conversation_id: string;
  seq: number;
  role: "user" | "assistant";
  text: string;
  tools: string | null;
  created_at: number;
}

export interface KeptQuestionRow {
  id: number;
  text: string;
  note: string | null;
  kept_at: number;
  conversation_id: string | null;
}

export interface IdleConversation {
  id: string;
  locale: string;
}

export interface AppendTurnInput {
  id: string;
  now: number;
  locale: string;
  page: string | null;
  country: string | null;
  callerKey: string | null;
  model: string | null;
  user: string;
  assistant: string;
  tools: { name: string; slug?: string }[];
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  cited: string[];
}

export interface ListConversationsInput {
  sinceMs: number;
  page: number;
  pageSize?: number;
}

export interface KeepQuestionInput {
  text: string;
  note?: string;
  conversationId?: string;
  now: number;
}

export async function getConversation(db: D1Database, id: string): Promise<ConversationRow | null> {
  return db
    .prepare(
      "SELECT id, started_at, last_at, locale, page, country, caller_key, turns, tokens_in, tokens_out, cost_usd, model, topic, handoff, lead_sent, cited, text_deleted_at FROM conversations WHERE id = ?",
    )
    .bind(id)
    .first<ConversationRow>();
}

function mergeCited(existingJson: string | null | undefined, cited: string[]): string {
  let merged: string[] = [];
  if (existingJson) {
    try {
      const parsed: unknown = JSON.parse(existingJson);
      if (Array.isArray(parsed)) merged = parsed.filter((u): u is string => typeof u === "string");
    } catch {
      merged = [];
    }
  }
  for (const url of cited) {
    if (!merged.includes(url)) merged.push(url);
  }
  return JSON.stringify(merged);
}

export async function appendTurn(db: D1Database, turn: AppendTurnInput): Promise<void> {
  const existing = await getConversation(db, turn.id);
  const maxSeq = await db
    .prepare("SELECT MAX(seq) AS max_seq FROM messages WHERE conversation_id = ?")
    .bind(turn.id)
    .first<number>("max_seq");
  const baseSeq = (maxSeq ?? -1) + 1;
  const cited = mergeCited(existing ? existing.cited : null, turn.cited);
  const conversationStmt = existing
    ? db
        .prepare(
          "UPDATE conversations SET last_at = ?, turns = turns + 1, tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, cost_usd = cost_usd + ?, cited = ? WHERE id = ?",
        )
        .bind(turn.now, turn.tokensIn, turn.tokensOut, turn.costUsd, cited, turn.id)
    : db
        .prepare(
          "INSERT INTO conversations (id, started_at, last_at, locale, page, country, caller_key, turns, tokens_in, tokens_out, cost_usd, model, cited) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)",
        )
        .bind(
          turn.id,
          turn.now,
          turn.now,
          turn.locale,
          turn.page,
          turn.country,
          turn.callerKey,
          turn.tokensIn,
          turn.tokensOut,
          turn.costUsd,
          turn.model,
          cited,
        );
  const userStmt = db
    .prepare("INSERT INTO messages (conversation_id, seq, role, text, tools, created_at) VALUES (?, ?, 'user', ?, NULL, ?)")
    .bind(turn.id, baseSeq, turn.user, turn.now);
  const assistantStmt = db
    .prepare("INSERT INTO messages (conversation_id, seq, role, text, tools, created_at) VALUES (?, ?, 'assistant', ?, ?, ?)")
    .bind(turn.id, baseSeq + 1, turn.assistant, JSON.stringify(turn.tools), turn.now);
  await db.batch([conversationStmt, userStmt, assistantStmt]);
}

export async function markHandoff(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE conversations SET handoff = 1 WHERE id = ?").bind(id).run();
}

export async function markLeadSent(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE conversations SET lead_sent = 1 WHERE id = ?").bind(id).run();
}

/**
 * Spend of conversations active since `sinceMs`. A conversation that began before
 * counts in full, so this over-estimates: fine for a soft cap.
 */
export async function todayCostUsd(db: D1Database, sinceMs: number): Promise<number> {
  const total = await db
    .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM conversations WHERE last_at >= ?")
    .bind(sinceMs)
    .first<number>("total");
  return total ?? 0;
}

export async function setTopic(db: D1Database, id: string, topic: string): Promise<void> {
  await db.prepare("UPDATE conversations SET topic = ? WHERE id = ?").bind(topic, id).run();
}

export async function idleWithoutTopic(db: D1Database, olderThanMs: number, limit: number): Promise<IdleConversation[]> {
  const res = await db
    .prepare(
      "SELECT id, locale FROM conversations WHERE topic IS NULL AND text_deleted_at IS NULL AND last_at < ? ORDER BY last_at ASC LIMIT ?",
    )
    .bind(olderThanMs, limit)
    .all<IdleConversation>();
  return res.results;
}

/** Clears at most `RETENTION_BATCH` conversations per run; the next daily run takes the rest. */
export const RETENTION_BATCH = 200;

export async function applyRetention(db: D1Database, days: number, now: number): Promise<number> {
  const cutoff = now - days * 86400000;
  const due = await db
    .prepare("SELECT id FROM conversations WHERE last_at < ? AND text_deleted_at IS NULL ORDER BY last_at ASC LIMIT ?")
    .bind(cutoff, RETENTION_BATCH)
    .all<{ id: string }>();
  if (due.results.length === 0) return 0;
  const stmts = [];
  for (const row of due.results) {
    stmts.push(db.prepare("DELETE FROM messages WHERE conversation_id = ?").bind(row.id));
    stmts.push(db.prepare("UPDATE conversations SET caller_key = NULL, text_deleted_at = ? WHERE id = ?").bind(now, row.id));
  }
  await db.batch(stmts);
  return due.results.length;
}

export async function listConversations(db: D1Database, opts: ListConversationsInput): Promise<ConversationRow[]> {
  const pageSize = opts.pageSize ?? 50;
  const offset = opts.page * pageSize;
  const res = await db
    .prepare(
      "SELECT id, started_at, last_at, locale, page, country, caller_key, turns, tokens_in, tokens_out, cost_usd, model, topic, handoff, lead_sent, cited, text_deleted_at FROM conversations WHERE last_at >= ? ORDER BY last_at DESC LIMIT ? OFFSET ?",
    )
    .bind(opts.sinceMs, pageSize, offset)
    .all<ConversationRow>();
  return res.results;
}

export async function getMessages(db: D1Database, id: string): Promise<MessageRow[]> {
  const res = await db
    .prepare("SELECT conversation_id, seq, role, text, tools, created_at FROM messages WHERE conversation_id = ? ORDER BY seq ASC")
    .bind(id)
    .all<MessageRow>();
  return res.results;
}

export async function keepQuestion(db: D1Database, q: KeepQuestionInput): Promise<void> {
  await db
    .prepare("INSERT INTO kept_questions (text, note, kept_at, conversation_id) VALUES (?, ?, ?, ?)")
    .bind(q.text, q.note ?? null, q.now, q.conversationId ?? null)
    .run();
}

export async function deleteConversation(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM messages WHERE conversation_id = ?").bind(id),
    db.prepare("DELETE FROM conversations WHERE id = ?").bind(id),
  ]);
}

/** Adds spend outside a turn (summary, topic label) to a conversation. */
export async function addCost(db: D1Database, id: string, costUsd: number): Promise<void> {
  await db.prepare("UPDATE conversations SET cost_usd = cost_usd + ? WHERE id = ?").bind(costUsd, id).run();
}

export interface TopicCountRow {
  topic: string;
  n: number;
}

export async function askTopicCounts(db: D1Database, sinceMs: number): Promise<TopicCountRow[]> {
  const res = await db
    .prepare(
      "SELECT COALESCE(topic, 'unlabelled') AS topic, COUNT(*) AS n FROM conversations WHERE last_at >= ? GROUP BY topic ORDER BY n DESC",
    )
    .bind(sinceMs)
    .all<TopicCountRow>();
  return res.results;
}

export interface OutcomeCounts {
  answered: number;
  handedOff: number;
  leads: number;
}

export async function askOutcomeCounts(db: D1Database, sinceMs: number): Promise<OutcomeCounts> {
  const res = await db
    .prepare(
      "SELECT SUM(CASE WHEN handoff = 0 AND lead_sent = 0 THEN 1 ELSE 0 END) AS answered, SUM(CASE WHEN handoff = 1 THEN 1 ELSE 0 END) AS handedOff, SUM(CASE WHEN lead_sent = 1 THEN 1 ELSE 0 END) AS leads FROM conversations WHERE last_at >= ?",
    )
    .bind(sinceMs)
    .first<OutcomeCounts>();
  return res ?? { answered: 0, handedOff: 0, leads: 0 };
}
