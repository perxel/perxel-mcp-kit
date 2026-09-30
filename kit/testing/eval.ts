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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
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
