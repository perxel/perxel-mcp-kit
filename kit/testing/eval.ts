import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export interface EvalCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface EvalQuestion {
  question: string;
  calls: EvalCall[];
  facts: string[];
}

/**
 * Parses `evals/questions.md`: `##` headings start a question, `- tool: <name>
 * <json args>` lines declare calls, `- expect: <fact>` lines declare facts that
 * must appear in the results. Throws on malformed lines.
 */
export function parseQuestions(markdown: string): EvalQuestion[] {
  const questions: EvalQuestion[] = [];
  let current: EvalQuestion | null = null;
  const flush = () => {
    if (current) {
      if (current.calls.length === 0) throw new Error(`eval question "${current.question}" has no - tool: lines`);
      if (current.facts.length === 0) throw new Error(`eval question "${current.question}" has no - expect: lines`);
      questions.push(current);
    }
    current = null;
  };
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("## ")) {
      flush();
      current = { question: line.slice(3).trim(), calls: [], facts: [] };
    } else if (line.startsWith("- tool:")) {
      if (!current) throw new Error(`- tool: outside a ## question: ${line}`);
      const rest = line.slice("- tool:".length).trim();
      const space = rest.search(/\s/);
      const tool = space < 0 ? rest : rest.slice(0, space);
      const argsText = space < 0 ? "{}" : rest.slice(space).trim();
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(argsText) as Record<string, unknown>;
      } catch {
        throw new Error(`bad JSON args for tool "${tool}": ${argsText}`);
      }
      current.calls.push({ tool, args });
    } else if (line.startsWith("- expect:")) {
      if (!current) throw new Error(`- expect: outside a ## question: ${line}`);
      current.facts.push(line.slice("- expect:".length).trim());
    } else if (line !== "" && !line.startsWith("#")) {
      // Prose between questions is ignored; inside a question it is a typo.
      if (current) throw new Error(`unrecognised eval line: ${line}`);
    }
  }
  flush();
  return questions;
}

export function isLocalhost(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1";
}

async function callTool(url: string, tool: string, args: Record<string, unknown>): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} calling ${tool}`);
  const text = await res.text();
  const dataLine = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("data:"));
  const msg = JSON.parse(dataLine ? dataLine.slice("data:".length).trim() : text) as {
    result?: unknown;
    error?: { message: string };
  };
  if (msg.error) throw new Error(`JSON-RPC error calling ${tool}: ${msg.error.message}`);
  return JSON.stringify(msg.result);
}

// ---------------------------------------------------------------------------
// --ask mode: one POST per question to POST /ask, scored against ask-questions.json
// ---------------------------------------------------------------------------

/** Cloudflare's always-pass test token (test secret `1x0000000000000000000000000000000AA`). */
export const TEST_TURNSTILE_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
const HANDOFF_TOOL_NAME = "suggest_handoff";
/** Action tools (`ask.actions`) by the action name a question expects. */
const ACTION_TOOL_NAMES: Record<string, AskActionName> = { prepare_lead: "lead", prepare_subscribe: "subscribe" };
type AskActionName = "lead" | "subscribe";
const DEFAULT_ASK_URL = "http://localhost:8788/ask";
const DEFAULT_ASK_ORIGIN = "http://localhost:3000";
const ASK_USAGE =
  "usage: pnpm eval --ask <questions.json> [--url http://localhost:8788/ask] [--origin http://localhost:3000] [--only id1,id2] [--allow-remote]";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AskQuestion {
  id: string;
  locale: "vi" | "en";
  question: string;
  mustMention: string[];
  mustLink: string[];
  mustNot: string[];
  expectHandoff: boolean;
  /** The action tool the answer must call; when omitted, it must call none. */
  expectAction?: AskActionName;
}

/** One `/ask` turn as seen by the scorer. */
export interface AskTurn {
  answer: string;
  links: string[];
  handoff: boolean;
  /** Content tool calls (the handoff and actions not counted). */
  tools?: number;
  /** Action tools called, by action name. */
  actions?: AskActionName[];
  error?: string;
}

export interface AskScore {
  pass: boolean;
  failed: string[];
}

export interface AskRequestBody {
  id: string;
  messages: { id: string; role: "user"; parts: { type: "text"; text: string }[] }[];
  locale: "vi" | "en";
  page: string;
  turnstileToken: string;
}

function fieldString(raw: Record<string, unknown>, key: string, where: string): string {
  const value = raw[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${where}: "${key}" must be a non-empty string`);
  return value;
}

function fieldStrings(raw: Record<string, unknown>, key: string, where: string): string[] {
  const value = raw[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`${where}: "${key}" must be an array of strings`);
  }
  return value as string[];
}

/** Parses `ask-questions.json`. Throws on a malformed entry (unknown keys are kept as-is). */
export function parseAskQuestions(text: string): AskQuestion[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`bad JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(raw)) throw new Error("questions file must be a JSON array");
  return raw.map((entry, index) => {
    const where = `question[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(`${where} must be an object`);
    const q = entry as Record<string, unknown>;
    const locale = q["locale"];
    if (locale !== "vi" && locale !== "en") throw new Error(`${where}: "locale" must be "vi" or "en"`);
    const expectHandoff = q["expectHandoff"];
    if (typeof expectHandoff !== "boolean") throw new Error(`${where}: "expectHandoff" must be a boolean`);
    const expectAction = q["expectAction"];
    if (expectAction !== undefined && expectAction !== "lead" && expectAction !== "subscribe") {
      throw new Error(`${where}: "expectAction" must be "lead" or "subscribe"`);
    }
    return {
      id: fieldString(q, "id", where),
      locale,
      question: fieldString(q, "question", where),
      mustMention: fieldStrings(q, "mustMention", where),
      mustLink: fieldStrings(q, "mustLink", where),
      mustNot: fieldStrings(q, "mustNot", where),
      expectHandoff,
      ...(expectAction ? { expectAction } : {}),
    };
  });
}

/** The `useChat`-shaped first-turn body, with a fresh conversation id each call. */
export function askRequestBody(question: AskQuestion): AskRequestBody {
  return {
    id: randomUUID(),
    messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: question.question }] }],
    locale: question.locale,
    page: "/eval",
    turnstileToken: TEST_TURNSTILE_TOKEN,
  };
}

/**
 * Pulls the answer out of a UI message SSE body (`data: {...}` lines): text
 * deltas into the answer, `source-url` urls into links (deduplicated), and
 * whether the `suggest_handoff` tool part appeared. Ignores `[DONE]` and
 * anything unparseable; an `error` chunk becomes `error`.
 */
export function parseAskSse(text: string): AskTurn {
  const answer: string[] = [];
  const links: string[] = [];
  let handoff = false;
  let tools = 0;
  const actions: AskActionName[] = [];
  let error: string | undefined;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice("data:".length).trim();
    if (payload.length === 0 || payload === "[DONE]") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const part = parsed as Record<string, unknown>;
    switch (part["type"]) {
      case "text-delta":
        if (typeof part["delta"] === "string") answer.push(part["delta"]);
        break;
      case "source-url":
        if (typeof part["url"] === "string" && !links.includes(part["url"])) links.push(part["url"]);
        break;
      case "tool-input-available": {
        const name = String(part["toolName"]);
        const action = ACTION_TOOL_NAMES[name];
        if (name === HANDOFF_TOOL_NAME) handoff = true;
        else if (action) {
          if (!actions.includes(action)) actions.push(action);
        } else tools++;
        break;
      }
      case "tool-input-start":
        if (part["toolName"] === HANDOFF_TOOL_NAME) handoff = true;
        break;
      case "error":
        error = typeof part["errorText"] === "string" ? part["errorText"] : "stream error";
        break;
      default:
        break;
    }
  }
  return { answer: answer.join(""), links, handoff, tools, actions, ...(error === undefined ? {} : { error }) };
}

/**
 * Scores one turn against its question (case-insensitive; Vietnamese diacritics
 * compared as-is): every `mustMention` in the answer, every `mustLink` in the
 * links or as text in the answer, no `mustNot` in the answer, and
 * `handoff === expectHandoff`, and exactly the expected action tool (or none).
 */
export function scoreAskAnswer(question: AskQuestion, turn: AskTurn): AskScore {
  const failed: string[] = [];
  const answer = turn.answer.toLowerCase();
  for (const needle of question.mustMention) {
    if (!answer.includes(needle.toLowerCase())) failed.push(`missing mustMention "${needle}"`);
  }
  for (const needle of question.mustLink) {
    const wanted = needle.toLowerCase();
    const inLinks = turn.links.some((link) => link.toLowerCase().includes(wanted));
    if (!inLinks && !answer.includes(wanted)) failed.push(`missing mustLink "${needle}"`);
  }
  for (const needle of question.mustNot) {
    if (answer.includes(needle.toLowerCase())) failed.push(`found mustNot "${needle}"`);
  }
  if (turn.handoff !== question.expectHandoff) {
    failed.push(`handoff=${turn.handoff} expected=${question.expectHandoff}`);
  }
  const got = (turn.actions ?? []).join(",") || "none";
  const want = question.expectAction ?? "none";
  if (got !== want) failed.push(`action=${got} expected=${want}`);
  if (turn.error) failed.push(`stream error: ${turn.error}`);
  return { pass: failed.length === 0, failed };
}

/** Turns a finished response into an `AskTurn`: worker errors are JSON, success is SSE. */
function askTurnFromResponse(res: Response, text: string): AskTurn {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = JSON.parse(text) as { code?: unknown };
      if (typeof body.code === "string") detail = body.code;
    } catch {
      // keep the status
    }
    return { answer: "", links: [], handoff: false, error: `refused: ${detail}` };
  }
  const turn = parseAskSse(text);
  if (turn.error) return turn;
  if (!res.ok) return { ...turn, error: `HTTP ${res.status}` };
  if (!text.includes("data:")) return { ...turn, error: `unexpected response body (HTTP ${res.status})` };
  return turn;
}

interface AskArgs {
  questionsPath: string;
  url: URL;
  origin: string;
  only: string[] | null;
}

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
  return value;
}

function readAskArgs(argv: string[]): AskArgs | null {
  try {
    const askIndex = argv.indexOf("--ask");
    const questionsPath = argv[askIndex + 1];
    if (!questionsPath || questionsPath.startsWith("--")) throw new Error("--ask needs a questions.json path");
    const urlText = flagValue(argv, "--url") ?? DEFAULT_ASK_URL;
    const origin = flagValue(argv, "--origin") ?? DEFAULT_ASK_ORIGIN;
    const onlyText = flagValue(argv, "--only");
    const allowRemote = argv.includes("--allow-remote");
    const url = new URL(urlText);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`invalid --url ${urlText}`);
    if (!isLocalhost(url) && !allowRemote) {
      console.error(
        `refusing --url ${urlText}: this eval posts Cloudflare's test Turnstile token, which only passes when the Worker runs the local test TURNSTILE_SECRET; --allow-remote is required to hit ${url.host}.`,
      );
      return null;
    }
    try {
      new URL(origin);
    } catch {
      throw new Error(`invalid --origin ${origin}`);
    }
    const only = onlyText === undefined ? null : onlyText.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    return { questionsPath, url, origin, only };
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(ASK_USAGE);
    return null;
  }
}

interface AskRow {
  id: string;
  locale: string;
  pass: boolean;
  failed: string[];
  latencyMs: number;
  /** ms from sending to the first answer text; null when none came. */
  firstTextMs: number | null;
  tools: number;
  /** False when the turn was refused or errored: left out of the timing figures. */
  answered: boolean;
}

/** Nearest-rank percentile of a list of numbers; null when empty. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

function printAskReport(rows: AskRow[]): void {
  const header = ["id", "locale", "result", "failed", "first ms", "total ms", "tools"];
  const body = rows.map((row) => [
    row.id,
    row.locale,
    row.pass ? "pass" : "fail",
    row.failed.join("; ") || "-",
    row.firstTextMs === null ? "-" : String(row.firstTextMs),
    String(row.latencyMs),
    String(row.tools),
  ]);
  const widths = header.map((column, i) => Math.max(column.length, ...body.map((row) => row[i].length)));
  const line = (row: string[]): string =>
    row.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd();
  console.log(line(header));
  for (const row of body) console.log(line(row));
  const passed = rows.filter((row) => row.pass).length;
  const pct = (n: number, d: number): string => `${((n / d) * 100).toFixed(1)}%`;
  console.log("");
  console.log(`pass rate: ${passed}/${rows.length} (${pct(passed, rows.length)})`);
  for (const locale of [...new Set(rows.map((row) => row.locale))].sort()) {
    const group = rows.filter((row) => row.locale === locale);
    const ok = group.filter((row) => row.pass).length;
    console.log(`  ${locale}: ${ok}/${group.length} (${pct(ok, group.length)})`);
  }
  const answered = rows.filter((row) => row.answered);
  const first = answered.flatMap((row) => (row.firstTextMs === null ? [] : [row.firstTextMs]));
  const total = answered.map((row) => row.latencyMs);
  const fmt = (n: number | null): string => (n === null ? "-" : `${n} ms`);
  console.log(`timing over ${answered.length} answered turns:`);
  console.log(`  first text: p50 ${fmt(percentile(first, 50))}, p90 ${fmt(percentile(first, 90))}`);
  console.log(`  full answer: p50 ${fmt(percentile(total, 50))}, p90 ${fmt(percentile(total, 90))}`);
  const tools = answered.length ? answered.reduce((a, row) => a + row.tools, 0) / answered.length : 0;
  console.log(`  tool calls per answer: ${tools.toFixed(2)}`);
}

/** Reads a streamed response to the end, noting when the first answer text arrived. */
async function readTimed(res: Response, started: number): Promise<{ text: string; firstTextMs: number | null }> {
  if (!res.body) return { text: await res.text(), firstTextMs: null };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let firstTextMs: number | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (firstTextMs === null && text.includes('"type":"text-delta"')) firstTextMs = Date.now() - started;
  }
  return { text: text + decoder.decode(), firstTextMs };
}

async function runAsk(argv: string[]): Promise<void> {
  const args = readAskArgs(argv);
  if (!args) {
    process.exit(2);
    return;
  }
  let questions: AskQuestion[];
  try {
    questions = parseAskQuestions(readFileSync(args.questionsPath, "utf8"));
  } catch (err) {
    console.error(`${args.questionsPath}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
    return;
  }
  const only = args.only;
  if (only) {
    questions = questions.filter((question) => only.includes(question.id));
    if (questions.length === 0) {
      console.error(`--only matched none of: ${only.join(", ")}`);
      process.exit(2);
      return;
    }
  }

  const rows: AskRow[] = [];
  for (const question of questions) {
    let started = Date.now();
    let turn: AskTurn;
    let firstTextMs: number | null = null;
    try {
      const send = () =>
        fetch(args.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream",
            origin: args.origin,
          },
          body: JSON.stringify(askRequestBody(question)),
        });
      let res = await send();
      // The per-IP limiter (6 a minute by default) applies locally too: wait it out once.
      if (res.status === 429) {
        const wait = Number(res.headers.get("retry-after") ?? "60") || 60;
        await res.body?.cancel();
        console.log(`     rate limited, waiting ${wait}s`);
        await new Promise((r) => setTimeout(r, wait * 1000));
        started = Date.now();
        res = await send();
      }
      const read = await readTimed(res, started);
      firstTextMs = read.firstTextMs;
      turn = askTurnFromResponse(res, read.text);
    } catch (err) {
      turn = { answer: "", links: [], handoff: false, error: err instanceof Error ? err.message : String(err) };
    }
    const latencyMs = Date.now() - started;
    const score = scoreAskAnswer(question, turn);
    rows.push({ id: question.id, locale: question.locale, pass: score.pass, failed: score.failed, latencyMs, firstTextMs, tools: turn.tools ?? 0, answered: !turn.error });
    console.log(`${score.pass ? "ok  " : "FAIL"} ${question.id} first ${firstTextMs ?? "-"}ms, total ${latencyMs}ms, ${turn.tools ?? 0} tools`);
  }
  console.log("");
  printAskReport(rows);
  if (rows.some((row) => !row.pass)) process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--ask")) {
    await runAsk(argv);
    return;
  }
  const urlIdx = argv.indexOf("--url");
  const questionsIdx = argv.indexOf("--questions");
  const allowRemote = argv.includes("--allow-remote");
  const urlText = urlIdx >= 0 ? argv[urlIdx + 1] : undefined;
  if (!urlText) {
    console.error("usage: pnpm eval -- --url <mcp url> [--questions <path>] [--allow-remote]");
    process.exit(2);
  }
  const url = new URL(urlText);
  // Never point a local client at production: remote URLs need --allow-remote.
  if (!isLocalhost(url) && !allowRemote) {
    console.error(`refusing non-local URL ${urlText} without --allow-remote`);
    process.exit(2);
  }
  const questions = parseQuestions(readFileSync(questionsIdx >= 0 ? argv[questionsIdx + 1] : "evals/questions.md", "utf8"));
  let failed = 0;
  for (const q of questions) {
    try {
      const results: string[] = [];
      for (const call of q.calls) results.push(await callTool(urlText, call.tool, call.args));
      const haystack = results.join("\n");
      const missing = q.facts.filter((f) => !haystack.includes(f));
      if (missing.length > 0) {
        failed += 1;
        console.log(`FAIL ${q.question}\n  missing: ${missing.join(", ")}`);
      } else {
        console.log(`ok ${q.question}`);
      }
    } catch (err) {
      failed += 1;
      console.log(`FAIL ${q.question}\n  ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`${questions.length - failed}/${questions.length} evals passed`);
  if (failed > 0) process.exit(1);
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  await main();
}
