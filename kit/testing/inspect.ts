import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { isLocalhost } from "./eval.js";

/**
 * `pnpm inspect [mcp url] [--allow-remote]`: opens the MCP Inspector UI on
 * http://localhost:8002 against one MCP URL (default the local
 * `wrangler dev` server). The Inspector is never deployed: it runs on the
 * developer's machine only. Same rule as `pnpm eval`: a non-local URL needs
 * `--allow-remote`, so production is only ever inspected on purpose.
 */

export const DEFAULT_URL = "http://localhost:8788/mcp";

/** Parses argv into the server URL, or an error message. */
export function parseInspectArgs(argv: string[]): { url: string } | { error: string } {
  const allowRemote = argv.includes("--allow-remote");
  const positional = argv.filter((a) => !a.startsWith("--"));
  const text = positional[0] ?? DEFAULT_URL;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { error: `not a URL: ${text}` };
  }
  if (!url.pathname.endsWith("/mcp")) return { error: `expected the MCP endpoint (…/mcp), got ${text}` };
  if (!isLocalhost(url) && !allowRemote) return { error: `refusing non-local URL ${text} without --allow-remote` };
  return { url: url.href };
}

function main(): void {
  const parsed = parseInspectArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(parsed.error);
    console.error("usage: pnpm inspect [mcp url] [--allow-remote]");
    process.exit(2);
  }
  console.log(`\n  MCP Inspector -> http://localhost:8002  (server: ${parsed.url})\n`);
  const child = spawn("pnpm", ["exec", "@modelcontextprotocol/inspector", "--transport", "http", "--server-url", parsed.url], {
    stdio: "inherit",
    env: { ...process.env, CLIENT_PORT: "8002" },
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) main();
