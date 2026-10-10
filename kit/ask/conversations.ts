import type { McpConfig } from "../core/config.js";
import { checkDashAccess, DASH_HEADERS, escapeHtml, plainPage } from "../core/dash.js";
import type { Env } from "../core/env.js";
import {
  deleteConversation,
  getConversation,
  getMessages,
  keepQuestion,
  listConversations,
  type ConversationRow,
} from "./store.js";

/**
 * `<DASH_PATH>/conversations`: the owner's review of Ask conversations (stripped text).
 *
 * Always private: the Access check runs even when `DASH_PUBLIC=true` (the public
 * dashboard shows counts and topics only). The Access app guarding this path may be
 * its own (`ASK_DASH_ACCESS_AUD`) or the dashboard's (`DASH_ACCESS_AUD`). Only local
 * dev (localhost) skips it. Actions are POST with a same-origin check.
 */

const RANGES = { "7d": 7, "30d": 30, "90d": 90 } as const;
type Range = keyof typeof RANGES;
const PAGE_SIZE = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isConversationsPath(path: string, dashPath: string): boolean {
  const base = `${dashPath}/conversations`;
  return path === base || path.startsWith(`${base}/`);
}

function page(title: string, body: string): Response {
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="robots" content="noindex"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;max-width:960px;margin:32px auto;padding:0 16px;color:#111}
a{color:#0645ad}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #e5e5e5;vertical-align:top}
th{font-weight:600;color:#555}.msg{border:1px solid #e5e5e5;border-radius:8px;padding:10px 12px;margin:10px 0;white-space:pre-wrap}
.user{background:#f6f6f6}.meta{color:#777;font-size:12px}form{display:inline}button{font:inherit;padding:2px 10px;cursor:pointer}
.danger{color:#b00020}nav a{margin-right:12px}
</style><body>${body}</body></html>`;
  return new Response(html, { headers: DASH_HEADERS });
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

function citedOf(row: ConversationRow): string[] {
  try {
    const v: unknown = JSON.parse(row.cited ?? "[]");
    return Array.isArray(v) ? v.filter((u): u is string => typeof u === "string") : [];
  } catch {
    return [];
  }
}

/** True for a browser POST from this same origin (Origin, else Sec-Fetch-Site). */
function sameOrigin(request: Request, local: boolean): boolean {
  if (local) return true;
  const origin = request.headers.get("origin");
  if (origin) return origin === new URL(request.url).origin;
  return request.headers.get("sec-fetch-site") === "same-origin";
}

function isLocal(request: Request, env: Env): boolean {
  const local = (u: string) => {
    try {
      const h = new URL(u).hostname;
      return h === "localhost" || h === "127.0.0.1";
    } catch {
      return false;
    }
  };
  return local(request.url) || (typeof env.MCP_PUBLIC_URL === "string" && local(env.MCP_PUBLIC_URL));
}

export async function handleConversations(
  request: Request,
  env: Env,
  config: McpConfig,
  dashPath: string,
  now: number = Date.now(),
): Promise<Response> {
  const access = await checkDashAccess(request, env, now, {
    ignorePublic: true,
    aud: env.ASK_DASH_ACCESS_AUD ?? env.DASH_ACCESS_AUD,
  });
  if (access instanceof Response) return access;
  if (!config.ask) return plainPage(404, "Not found", "Ask is not enabled on this MCP.");
  const db = env.ASK_DB;
  if (!db) return plainPage(503, "No database", "Bind ASK_DB (D1) to see conversations.");

  const url = new URL(request.url);
  const base = `${dashPath}/conversations`;
  const rest = url.pathname.slice(base.length).replace(/^\/+|\/+$/g, "");

  if (request.method === "POST") {
    if (!sameOrigin(request, isLocal(request, env))) return plainPage(403, "Forbidden", "Cross-site request refused.");
    if (!UUID_RE.test(rest)) return plainPage(404, "Not found", "No such conversation.");
    const form = await request.formData().catch(() => null);
    const action = form?.get("action");
    if (action === "delete") {
      await deleteConversation(db, rest);
      return new Response(null, { status: 303, headers: { location: `${base}/` } });
    }
    if (action === "keep") {
      const seq = Number(form?.get("seq"));
      const msg = (await getMessages(db, rest)).find((m) => m.seq === seq && m.role === "user");
      if (!msg) return plainPage(400, "Bad request", "No such visitor message.");
      const note = String(form?.get("note") ?? "").slice(0, 500);
      await keepQuestion(db, { text: msg.text, ...(note ? { note } : {}), conversationId: rest, now });
      return new Response(null, { status: 303, headers: { location: `${base}/${rest}?kept=1` } });
    }
    return plainPage(400, "Bad request", "Unknown action.");
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD, POST" } });
  }

  if (rest === "") {
    if (!url.pathname.endsWith("/")) return new Response(null, { status: 308, headers: { location: `${base}/${url.search}` } });
    const rangeParam = url.searchParams.get("range") ?? "30d";
    const range: Range = rangeParam in RANGES ? (rangeParam as Range) : "30d";
    const pageNo = Math.max(0, Math.min(1000, Number.parseInt(url.searchParams.get("page") ?? "0", 10) || 0));
    const rows = await listConversations(db, { sinceMs: now - RANGES[range] * 86_400_000, page: pageNo, pageSize: PAGE_SIZE });
    const tr = rows
      .map(
        (r) =>
          `<tr><td><a href="${base}/${escapeHtml(r.id)}">${fmtDate(r.last_at)}</a></td><td>${escapeHtml(r.locale)}</td><td>${escapeHtml(
            r.topic ?? "",
          )}</td><td>${r.turns}</td><td>${r.handoff ? "yes" : ""}</td><td>${r.lead_sent ? "yes" : ""}</td><td>$${r.cost_usd.toFixed(4)}</td><td>${
            r.text_deleted_at ? "text deleted" : ""
          }</td></tr>`,
      )
      .join("");
    const ranges = (Object.keys(RANGES) as Range[])
      .map((k) => (k === range ? `<strong>${k}</strong>` : `<a href="?range=${k}">${k}</a>`))
      .join(" ");
    const pager =
      (pageNo > 0 ? `<a href="?range=${range}&page=${pageNo - 1}">Newer</a> ` : "") +
      (rows.length === PAGE_SIZE ? `<a href="?range=${range}&page=${pageNo + 1}">Older</a>` : "");
    return page(
      `${config.name}: Ask conversations`,
      `<nav><a href="${dashPath}/">Dashboard</a></nav><h1>Ask conversations</h1><p>${ranges}</p>
<p class="meta">Visitor text is stripped of emails, phone numbers and long numbers, and deleted after ${
        config.ask.retentionDays ?? 90
      } days.</p>
<table><tr><th>Last message (UTC)</th><th>Locale</th><th>Topic</th><th>Turns</th><th>Handoff</th><th>Lead</th><th>Cost</th><th></th></tr>${
        tr || `<tr><td colspan="8">No conversations in this range.</td></tr>`
      }</table><p>${pager}</p>`,
    );
  }

  if (!UUID_RE.test(rest)) return plainPage(404, "Not found", "No such conversation.");
  const convo = await getConversation(db, rest);
  if (!convo) return plainPage(404, "Not found", "No such conversation.");
  const msgs = await getMessages(db, rest);
  const items = msgs
    .map((m) => {
      let tools = "";
      if (m.role === "assistant" && m.tools) {
        try {
          const list = JSON.parse(m.tools) as { name: string; slug?: string }[];
          tools = list.map((t) => escapeHtml(t.slug ? `${t.name} (${t.slug})` : t.name)).join(", ");
        } catch {
          tools = "";
        }
      }
      const keep =
        m.role === "user"
          ? ` <form method="post"><input type="hidden" name="action" value="keep"><input type="hidden" name="seq" value="${m.seq}"><input name="note" placeholder="note" maxlength="500"> <button>Keep question</button></form>`
          : "";
      return `<div class="msg ${m.role}"><div class="meta">${m.role === "user" ? "Visitor" : "Ask"} · ${fmtDate(m.created_at)}${
        tools ? ` · tools: ${tools}` : ""
      }${keep}</div>${escapeHtml(m.text)}</div>`;
    })
    .join("");
  const cited = citedOf(convo)
    .map((u) => `<li>${escapeHtml(u)}</li>`)
    .join("");
  return page(
    `${config.name}: conversation`,
    `<nav><a href="${base}/">All conversations</a></nav><h1>Conversation</h1>
${url.searchParams.get("kept") ? `<p><strong>Question kept.</strong></p>` : ""}
<p class="meta">${escapeHtml(convo.locale)} · ${escapeHtml(convo.page ?? "")} · ${escapeHtml(convo.country ?? "")} · topic ${escapeHtml(
      convo.topic ?? "none yet",
    )} · ${convo.turns} turns · handoff ${convo.handoff ? "yes" : "no"} · lead ${convo.lead_sent ? "yes" : "no"} · $${convo.cost_usd.toFixed(4)} · ${escapeHtml(
      convo.model ?? "",
    )}</p>
${convo.text_deleted_at ? `<p>Text deleted ${fmtDate(convo.text_deleted_at)} (retention).</p>` : items}
${cited ? `<h2>Cited pages</h2><ul>${cited}</ul>` : ""}
<form method="post"><input type="hidden" name="action" value="delete"><button class="danger">Delete conversation</button></form>`,
  );
}
