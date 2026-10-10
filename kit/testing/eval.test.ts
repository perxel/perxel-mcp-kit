import { describe, expect, it } from "vitest";
import {
  askRequestBody,
  parseAskQuestions,
  parseAskSse,
  parseQuestions,
  scoreAskAnswer,
  TEST_TURNSTILE_TOKEN,
  type AskQuestion,
  type AskTurn,
} from "./eval.js";

describe("parseQuestions", () => {
  it("parses questions with calls and facts", () => {
    const qs = parseQuestions(`# Title

## What time is it?

- tool: get_time {"timezone": "UTC"}
- tool: get_time {}
- expect: UTC
- expect: time
`);
    expect(qs).toEqual([
      {
        question: "What time is it?",
        calls: [
          { tool: "get_time", args: { timezone: "UTC" } },
          { tool: "get_time", args: {} },
        ],
        facts: ["UTC", "time"],
      },
    ]);
  });

  it("defaults missing args to {}", () => {
    const qs = parseQuestions("## Q\n- tool: whoami\n- expect: user\n");
    expect(qs[0].calls).toEqual([{ tool: "whoami", args: {} }]);
  });

  it("parses the shipped evals/questions.md", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const md = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "evals", "questions.md"), "utf8");
    const qs = parseQuestions(md);
    expect(qs.length).toBeGreaterThan(0); // the clone ships its own questions
    for (const q of qs) {
      expect(q.calls.length).toBeGreaterThan(0);
      expect(q.facts.length).toBeGreaterThan(0);
    }
  });

  it("rejects malformed input", () => {
    expect(() => parseQuestions("## Q\n- expect: x\n")).toThrow(/no - tool:/);
    expect(() => parseQuestions("## Q\n- tool: t {}\n")).toThrow(/no - expect:/);
    expect(() => parseQuestions("## Q\n- tool: t {oops}\n- expect: x\n")).toThrow(/bad JSON/);
    expect(() => parseQuestions("- tool: t {}\n")).toThrow(/outside a ## question/);
    expect(() => parseQuestions("## Q\nsome random line\n- tool: t {}\n- expect: x\n")).toThrow(/unrecognised/);
  });
});

function askQuestion(over: Partial<AskQuestion> = {}): AskQuestion {
  return {
    id: "vi-01",
    locale: "vi",
    question: "Perxel có làm website WordPress bằng custom theme không?",
    mustMention: [],
    mustLink: [],
    mustNot: [],
    expectHandoff: false,
    ...over,
  };
}

function sse(...events: unknown[]): string {
  return events.map((event) => `data: ${event === "[DONE]" ? "[DONE]" : JSON.stringify(event)}\n\n`).join("");
}

describe("parseAskSse", () => {
  it("collects text deltas, source urls and the handoff tool", () => {
    const turn = parseAskSse(
      sse(
        { type: "start", messageId: "m" },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Perxel có " },
        { type: "text-delta", id: "t1", delta: "custom theme." },
        { type: "text-end", id: "t1" },
        { type: "source-url", sourceId: "s1", url: "https://perxel.com/services/wordpress-custom-theme", title: "t" },
        { type: "tool-input-start", toolCallId: "c1", toolName: "suggest_handoff" },
        { type: "finish", finishReason: "stop" },
        "[DONE]",
      ),
    );
    expect(turn).toEqual({
      answer: "Perxel có custom theme.",
      links: ["https://perxel.com/services/wordpress-custom-theme"],
      handoff: true,
    });
  });

  it("dedupes links and ignores other tools", () => {
    const turn = parseAskSse(
      sse(
        { type: "source-url", sourceId: "a", url: "https://perxel.com/pricing" },
        { type: "source-url", sourceId: "b", url: "https://perxel.com/pricing" },
        { type: "tool-input-available", toolCallId: "c1", toolName: "search_content", input: {} },
        { type: "tool-input-start", toolCallId: "c2", toolName: "get_item" },
        { type: "text-delta", id: "t", delta: "20.000.000đ" },
      ),
    );
    expect(turn).toEqual({ answer: "20.000.000đ", links: ["https://perxel.com/pricing"], handoff: false });
  });

  it("records an error chunk and skips junk lines", () => {
    expect(parseAskSse("data: [DONE]\n\ndata: {oops\n\ndata: not even close\n\n")).toEqual({
      answer: "",
      links: [],
      handoff: false,
    });
    expect(parseAskSse(sse({ type: "error", errorText: "upstream" }))).toEqual({
      answer: "",
      links: [],
      handoff: false,
      error: "upstream",
    });
  });

  it("parses a real-shaped stream with one delta per line", () => {
    const text = [
      'data: {"type":"text-delta","id":"t1","delta":"Bảng giá"}',
      "",
      'data: {"type":"text-delta","id":"t1","delta":" xem /pricing."}',
      "",
      'data: {"type":"source-url","sourceId":"https://perxel.com/pricing","url":"https://perxel.com/pricing"}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const turn = parseAskSse(text);
    expect(turn.answer).toBe("Bảng giá xem /pricing.");
    expect(turn.links).toEqual(["https://perxel.com/pricing"]);
    expect(turn.handoff).toBe(false);
  });
});

describe("scoreAskAnswer", () => {
  const turn = (over: Partial<AskTurn> = {}): AskTurn => ({
    answer: "Perxel làm custom theme WordPress. Bảng giá xem https://perxel.com/pricing",
    links: ["https://perxel.com/services/wordpress-custom-theme"],
    handoff: false,
    ...over,
  });

  it("passes when every check holds", () => {
    const score = scoreAskAnswer(
      askQuestion({
        mustMention: ["custom theme", "WordPress"],
        mustLink: ["https://perxel.com/services/wordpress-custom-theme", "https://perxel.com/pricing"],
        mustNot: ["miễn phí"],
        expectHandoff: false,
      }),
      turn(),
    );
    expect(score).toEqual({ pass: true, failed: [] });
  });

  it("matches case-insensitively but keeps Vietnamese diacritics", () => {
    const pass = scoreAskAnswer(askQuestion({ mustMention: ["CUSTOM THEME"] }), turn({ answer: "chúng tôi làm custom theme." }));
    expect(pass.pass).toBe(true);
    const diacritics = scoreAskAnswer(askQuestion({ mustMention: ["Perxel có làm"] }), turn({ answer: "Perxel co lam website" }));
    expect(diacritics.failed).toEqual(['missing mustMention "Perxel có làm"']);
  });

  it("accepts a mustLink from the links or as text in the answer", () => {
    const inLinks = scoreAskAnswer(
      askQuestion({ mustLink: ["https://perxel.com/services/wordpress-custom-theme"] }),
      turn(),
    );
    expect(inLinks.pass).toBe(true);
    const inAnswer = scoreAskAnswer(askQuestion({ mustLink: ["https://perxel.com/pricing"] }), turn());
    expect(inAnswer.pass).toBe(true);
    const missing = scoreAskAnswer(askQuestion({ mustLink: ["https://perxel.com/contact"] }), turn());
    expect(missing.failed).toEqual(['missing mustLink "https://perxel.com/contact"']);
  });

  it("fails on a forbidden phrase and on a wrong handoff", () => {
    const score = scoreAskAnswer(
      askQuestion({ mustNot: ["flutter", "react native"], expectHandoff: false }),
      turn({ answer: "Perxel không làm flutter.", handoff: true }),
    );
    expect(score.failed).toEqual(['found mustNot "flutter"', "handoff=true expected=false"]);
    const noHandoff = scoreAskAnswer(askQuestion({ expectHandoff: true }), turn());
    expect(noHandoff.failed).toEqual(["handoff=false expected=true"]);
  });

  it("fails on a stream error even when the text matches", () => {
    const score = scoreAskAnswer(askQuestion({ mustMention: ["custom theme"] }), turn({ error: "refused: verify_failed" }));
    expect(score.failed).toEqual(["stream error: refused: verify_failed"]);
  });
});

describe("parseAskQuestions", () => {
  const good = JSON.stringify([
    {
      id: "vi-01",
      locale: "vi",
      question: "Perxel có làm gì?",
      mustMention: ["wordpress"],
      mustLink: ["https://perxel.com/services/wordpress-custom-theme"],
      mustNot: [],
      expectHandoff: false,
    },
  ]);

  it("parses a questions file", () => {
    const questions = parseAskQuestions(good);
    expect(questions).toEqual([
      {
        id: "vi-01",
        locale: "vi",
        question: "Perxel có làm gì?",
        mustMention: ["wordpress"],
        mustLink: ["https://perxel.com/services/wordpress-custom-theme"],
        mustNot: [],
        expectHandoff: false,
      },
    ]);
  });

  it("rejects malformed input", () => {
    expect(() => parseAskQuestions("{oops")).toThrow(/bad JSON/);
    expect(() => parseAskQuestions("{}")).toThrow(/JSON array/);
    expect(() => parseAskQuestions('[{"id":"x","locale":"fr","question":"q","expectHandoff":false}]')).toThrow(
      /"locale" must be "vi" or "en"/,
    );
    expect(() => parseAskQuestions('[{"id":"x","locale":"vi","question":"q"}]')).toThrow(/"expectHandoff" must be a boolean/);
    expect(() => parseAskQuestions('[{"locale":"vi","question":"q","expectHandoff":true}]')).toThrow(/"id" must be a non-empty string/);
    expect(() => parseAskQuestions('[{"id":"x","locale":"en","expectHandoff":true}]')).toThrow(/"question" must be a non-empty string/);
    expect(() => parseAskQuestions('[{"id":"x","locale":"en","question":"q","expectHandoff":true,"mustNot":"no"}]')).toThrow(
      /"mustNot" must be an array of strings/,
    );
  });
});

describe("askRequestBody", () => {
  it("builds one first turn with a fresh UUID and the test token", () => {
    const question = askQuestion();
    const body = askRequestBody(question);
    const again = askRequestBody(question);
    expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(body.id).not.toBe(again.id);
    expect(body.messages).toEqual([{ id: "m1", role: "user", parts: [{ type: "text", text: question.question }] }]);
    expect(body.locale).toBe("vi");
    expect(body.page).toBe("/eval");
    expect(body.turnstileToken).toBe(TEST_TURNSTILE_TOKEN);
    expect(body.turnstileToken).toBe("XXXX.DUMMY.TOKEN.XXXX");
  });
});
