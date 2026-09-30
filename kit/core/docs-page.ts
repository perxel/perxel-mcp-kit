import type { McpConfig } from "./config.js";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Docs page at `GET /`: connect steps plus the tool list, generated from the
 * tool definitions so it can't go stale when a tool is added or renamed.
 */
export function renderDocsPage(config: McpConfig, publicUrl: string): string {
  const mcpUrl = `${publicUrl.replace(/\/$/, "")}/mcp`;
  const rows = config.tools
    .map(
      (t) =>
        `<tr><td><code>${escapeHtml(t.name)}</code></td><td>${escapeHtml(t.title)}</td>` +
        `<td>${escapeHtml(t.description)}</td>` +
        `<td><span class="badge ${t.access}">${t.access}</span></td>` +
        `<td>${t.example ? escapeHtml(t.example) : ""}</td></tr>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(config.name)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 780px; margin: 40px auto; padding: 0 16px; }
  h1 { font-size: 22px; }
  h2 { font-size: 16px; margin-top: 2em; }
  code, pre { font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
  pre { background: rgba(127,127,127,0.12); padding: 10px 12px; border-radius: 8px; overflow-x: auto; }
  .url-row { display: flex; gap: 8px; align-items: center; }
  .url-row code { flex: 1; padding: 8px 10px; background: rgba(127,127,127,0.12); border-radius: 6px; }
  button { cursor: pointer; padding: 6px 10px; border-radius: 6px; border: 1px solid rgba(127,127,127,0.4); background: transparent; }
  table { border-collapse: collapse; width: 100%; margin-top: 8px; }
  td, th { padding: 6px 8px; border-top: 1px solid rgba(127,127,127,0.2); vertical-align: top; font-size: 14px; text-align: left; }
  .badge { font-size: 12px; padding: 1px 8px; border-radius: 999px; border: 1px solid rgba(127,127,127,0.4); }
  .badge.private { border-color: currentColor; font-weight: 600; }
</style>
</head>
<body>
<h1>${escapeHtml(config.name)}</h1>
<p>${escapeHtml(config.description)}</p>

<div class="url-row">
  <code id="mcp-url">${escapeHtml(mcpUrl)}</code>
  <button onclick="navigator.clipboard.writeText(document.getElementById('mcp-url').textContent)">Copy</button>
</div>

<h2>Connect with Claude</h2>
<p>Settings → Connectors → Add custom connector → paste the URL above.${
    config.tools.some((t) => t.access === "private")
      ? " Public tools work right away; private ones show a Connect card to sign in."
      : ""
  }</p>
<p>Claude Code: <code>claude mcp add --transport http ${escapeHtml(config.slug)} ${escapeHtml(mcpUrl)}</code></p>

<h2>Tools</h2>
<table>
<tr><th>Name</th><th>Title</th><th>Description</th><th>Access</th><th>Example</th></tr>
${rows}
</table>

<p style="margin-top:3em; opacity:0.6; font-size:13px;">${escapeHtml(config.name)} v${escapeHtml(config.version)} · Contact: ${escapeHtml(config.docs.contact)}</p>
</body>
</html>`;
}
