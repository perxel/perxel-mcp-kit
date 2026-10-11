import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FakeD1 } from "./testing/fake-d1.js";
import {
  appendTurn,
  applyRetention,
  deleteConversation,
  getConversation,
  getMessages,
  idleWithoutTopic,
  keepQuestion,
  listConversations,
  loadTurnState,
  markHandoff,
  markLeadSent,
  setTopic,
  todayCostUsd,
  type AppendTurnInput,
} from "./store.js";

// The fake executes this real migration SQL, so the tests run against the real schema.
const INIT_SQL = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "migrations", "0001_init.sql"), "utf8");

function testDb(): { fake: FakeD1; db: D1Database } {
  const fake = new FakeD1(INIT_SQL);
  return { fake, db: fake as unknown as D1Database };
}

function turn(overrides: Partial<AppendTurnInput> = {}): AppendTurnInput {
  return {
    id: "conv-1",
    now: 1_000_000,
    locale: "vi",
    page: "/dich-vu",
    country: "VN",
    callerKey: "hash-1",
    model: "vendor/model",
    user: "hello",
    assistant: "hi there",
    tools: [{ name: "search_content", slug: "dich-vu" }],
    tokensIn: 10,
    tokensOut: 20,
    costUsd: 0.001,
    cited: ["https://example.com/a"],
    ...overrides,
  };
}

describe("ask store", () => {
  it("loadTurnState reads the conversation, its messages and the spend in one batch", async () => {
    const { db } = testDb();
    expect(await loadTurnState(db, "conv-1", 0)).toEqual({ conversation: null, messages: [], costUsd: 0 });
    await appendTurn(db, turn());
    const state = await loadTurnState(db, "conv-1", 0);
    expect(state.conversation?.turns).toBe(1);
    expect(state.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(state.costUsd).toBeCloseTo(0.001);
    expect((await loadTurnState(db, "conv-1", null)).costUsd).toBeNull();
  });

  it("getConversation returns null for an unknown id", async () => {
    const { db } = testDb();
    expect(await getConversation(db, "missing")).toBeNull();
  });

  it("appendTurn creates the conversation row and the first two messages", async () => {
    const { db } = testDb();
    await appendTurn(db, turn());

    const conv = await getConversation(db, "conv-1");
    expect(conv).toMatchObject({
      id: "conv-1",
      started_at: 1_000_000,
      last_at: 1_000_000,
      locale: "vi",
      page: "/dich-vu",
      country: "VN",
      caller_key: "hash-1",
      turns: 1,
      tokens_in: 10,
      tokens_out: 20,
      cost_usd: 0.001,
      model: "vendor/model",
      topic: null,
      handoff: 0,
      lead_sent: 0,
      text_deleted_at: null,
    });
    expect(JSON.parse(conv?.cited ?? "[]")).toEqual(["https://example.com/a"]);

    const msgs = await getMessages(db, "conv-1");
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ conversation_id: "conv-1", seq: 0, role: "user", text: "hello", tools: null });
    expect(msgs[1]).toMatchObject({ conversation_id: "conv-1", seq: 1, role: "assistant", text: "hi there" });
    expect(JSON.parse(msgs[1].tools ?? "[]")).toEqual([{ name: "search_content", slug: "dich-vu" }]);
  });

  it("appendTurn across turns numbers seq 0..3, accumulates counters, merges cited", async () => {
    const { db } = testDb();
    await appendTurn(db, turn());
    await appendTurn(
      db,
      turn({
        now: 2_000_000,
        user: "second",
        assistant: "second answer",
        tools: [],
        tokensIn: 5,
        tokensOut: 7,
        costUsd: 0.002,
        cited: ["https://example.com/a", "https://example.com/b"],
      }),
    );

    const conv = await getConversation(db, "conv-1");
    expect(conv).toMatchObject({
      started_at: 1_000_000,
      last_at: 2_000_000,
      turns: 2,
      tokens_in: 15,
      tokens_out: 27,
    });
    expect(conv?.cost_usd).toBeCloseTo(0.003, 9);
    expect(JSON.parse(conv?.cited ?? "[]")).toEqual(["https://example.com/a", "https://example.com/b"]);

    const msgs = await getMessages(db, "conv-1");
    expect(msgs.map((m) => [m.seq, m.role, m.text])).toEqual([
      [0, "user", "hello"],
      [1, "assistant", "hi there"],
      [2, "user", "second"],
      [3, "assistant", "second answer"],
    ]);
  });

  it("markHandoff and markLeadSent set their flags", async () => {
    const { db } = testDb();
    await appendTurn(db, turn());
    await markHandoff(db, "conv-1");
    await markLeadSent(db, "conv-1");
    const conv = await getConversation(db, "conv-1");
    expect(conv).toMatchObject({ handoff: 1, lead_sent: 1 });
  });

  it("todayCostUsd sums only conversations active since the cutoff", async () => {
    const { db } = testDb();
    expect(await todayCostUsd(db, 0)).toBe(0);
    await appendTurn(db, turn({ id: "old", now: 100, costUsd: 0.5 }));
    await appendTurn(db, turn({ id: "new", now: 2_000_000, costUsd: 0.25 }));
    expect(await todayCostUsd(db, 1_000_000)).toBeCloseTo(0.25, 9);
    expect(await todayCostUsd(db, 0)).toBeCloseTo(0.75, 9);
  });

  it("setTopic stores the label", async () => {
    const { db } = testDb();
    await appendTurn(db, turn());
    await setTopic(db, "conv-1", "pricing");
    expect((await getConversation(db, "conv-1"))?.topic).toBe("pricing");
  });

  it("idleWithoutTopic returns old untagged rows oldest first, honoring the limit", async () => {
    const { db } = testDb();
    const now = 10_000_000;
    await appendTurn(db, turn({ id: "old-1", now: 100 }));
    await appendTurn(db, turn({ id: "old-2", now: 200 }));
    await appendTurn(db, turn({ id: "tagged", now: 300 }));
    await setTopic(db, "tagged", "mcp");
    await appendTurn(db, turn({ id: "fresh", now }));
    await appendTurn(db, turn({ id: "deleted", now: 50 }));
    // Retention cutoff between 50 and 100: only "deleted" loses its text.
    await applyRetention(db, (now - 75) / 86400000, now);

    expect(await idleWithoutTopic(db, 1_000_000, 10)).toEqual([
      { id: "old-1", locale: "vi" },
      { id: "old-2", locale: "vi" },
    ]);
    expect(await idleWithoutTopic(db, 1_000_000, 1)).toEqual([{ id: "old-1", locale: "vi" }]);
  });

  it("applyRetention clears text but keeps the conversation row and nulls caller_key", async () => {
    const { db } = testDb();
    const now = 10_000_000;
    await appendTurn(db, turn({ id: "old", now: 100, callerKey: "hash-old" }));
    await appendTurn(db, turn({ id: "recent", now, callerKey: "hash-new" }));

    const cleared = await applyRetention(db, (now - 1_000) / 86400000, now);
    expect(cleared).toBe(1);

    const old = await getConversation(db, "old");
    expect(old).not.toBeNull();
    expect(old).toMatchObject({ caller_key: null, text_deleted_at: now, turns: 1 });
    expect(await getMessages(db, "old")).toEqual([]);

    const recent = await getConversation(db, "recent");
    expect(recent).toMatchObject({ caller_key: "hash-new", text_deleted_at: null });
    expect(await getMessages(db, "recent")).toHaveLength(2);

    // A second run skips already-cleared rows.
    expect(await applyRetention(db, (now - 1_000) / 86400000, now)).toBe(0);
  });

  it("listConversations filters by recency, orders newest first, paginates", async () => {
    const { db } = testDb();
    await appendTurn(db, turn({ id: "a", now: 100 }));
    await appendTurn(db, turn({ id: "b", now: 200 }));
    await appendTurn(db, turn({ id: "c", now: 300 }));

    expect((await listConversations(db, { sinceMs: 0, page: 0 })).map((c) => c.id)).toEqual(["c", "b", "a"]);
    expect((await listConversations(db, { sinceMs: 150, page: 0 })).map((c) => c.id)).toEqual(["c", "b"]);
    expect((await listConversations(db, { sinceMs: 0, page: 0, pageSize: 2 })).map((c) => c.id)).toEqual(["c", "b"]);
    expect((await listConversations(db, { sinceMs: 0, page: 1, pageSize: 2 })).map((c) => c.id)).toEqual(["a"]);
    expect(await listConversations(db, { sinceMs: 0, page: 5, pageSize: 2 })).toEqual([]);
  });

  it("getMessages returns rows ordered by seq", async () => {
    const { db } = testDb();
    await appendTurn(db, turn());
    await appendTurn(db, turn({ now: 2_000_000, user: "q2", assistant: "a2" }));
    expect((await getMessages(db, "conv-1")).map((m) => m.seq)).toEqual([0, 1, 2, 3]);
    expect(await getMessages(db, "missing")).toEqual([]);
  });

  it("keepQuestion stores the text, note and conversation link", async () => {
    const { fake, db } = testDb();
    await appendTurn(db, turn());
    await keepQuestion(db, { text: "do you do wordpress?", note: "good faq", conversationId: "conv-1", now: 5_000 });
    await keepQuestion(db, { text: "bare question", now: 6_000 });

    const rows = fake.native.prepare("SELECT text, note, kept_at, conversation_id FROM kept_questions ORDER BY id ASC").all() as {
      text: string;
      note: string | null;
      kept_at: number;
      conversation_id: string | null;
    }[];
    expect(rows).toEqual([
      { text: "do you do wordpress?", note: "good faq", kept_at: 5_000, conversation_id: "conv-1" },
      { text: "bare question", note: null, kept_at: 6_000, conversation_id: null },
    ]);
  });

  it("deleteConversation removes the messages and the row, leaving others", async () => {
    const { db } = testDb();
    await appendTurn(db, turn({ id: "gone" }));
    await appendTurn(db, turn({ id: "stays" }));
    await deleteConversation(db, "gone");
    expect(await getConversation(db, "gone")).toBeNull();
    expect(await getMessages(db, "gone")).toEqual([]);
    expect(await getConversation(db, "stays")).not.toBeNull();
    expect(await getMessages(db, "stays")).toHaveLength(2);
  });
});
