import { describe, expect, it } from "vitest";
import { parseQuestions } from "./eval.js";

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
    expect(qs).toHaveLength(3);
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
