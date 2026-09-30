import type { McpConfig } from "./config.js";
import type { Env } from "./env.js";
import { verifyRs256Jwt } from "./jwt.js";

/**
 * Monitoring dashboard served by the MCP Worker itself at `DASH_PATH`
 * (default `/dash`, so `https://<host>/dash`). No container, no Grafana:
 * a fixed set of panels over the metrics row (STANDARD.md), rendered server
 * side as HTML + inline SVG, no client JS.
 *
 * Data: the Worker never holds the account-wide Analytics Engine token. It
 * sends fixed SQL (built here, never taken from the request) to the account's
 * metrics proxy over the `METRICS_PROXY` service binding with its own
 * `DASH_PROXY_KEY`; the proxy validates every query against `mcp_<slug>`.
 *
 * Access: a Cloudflare Access app on `<host><DASH_PATH>` does the sign-in at
 * the edge. The Worker re-checks the `Cf-Access-Jwt-Assertion` it adds
 * (signature, audience, issuer, expiry), so a missing or misconfigured Access
 * rule, or a request reaching the Worker another way (workers.dev, preview
 * URLs), fails closed. Only local dev (localhost) skips the check.
 */

export const DASH_RANGES = {
  "24h": { hours: 24, bucketHours: 1, label: "24 hours" },
  "7d": { hours: 168, bucketHours: 6, label: "7 days" },
  "30d": { hours: 720, bucketHours: 24, label: "30 days" },
  "90d": { hours: 2160, bucketHours: 24, label: "90 days" },
} as const;
export type DashRange = keyof typeof DASH_RANGES;

/** Paths the MCP Worker already owns; the dashboard can't mount on or under them. */
const RESERVED = ["/mcp", "/health", "/authorize", "/callback", "/token", "/register", "/.well-known"];

/** Analytics Engine dataset for a slug: `mcp_<slug>`, `-` → `_` (STANDARD.md). */
export function datasetFor(slug: string): string {
  return `mcp_${slug.replace(/-/g, "_")}`;
}

/**
 * The dashboard mount path from `DASH_PATH`: unset or empty → `/dash`,
 * `off` → disabled (null). A root, reserved or malformed path also disables
 * it rather than shadowing an MCP route.
 */
export function dashPathFor(env: Pick<Env, "DASH_PATH">): string | null {
  const raw = typeof env.DASH_PATH === "string" ? env.DASH_PATH.trim() : "";
  if (raw === "") return "/dash";
  if (raw.toLowerCase() === "off") return null;
  const path = "/" + raw.replace(/^\/+|\/+$/g, "");
  if (!/^\/[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/.test(path)) return null;
  if (RESERVED.some((r) => path === r || path.startsWith(`${r}/`))) return null;
  return path;
}

/** True when `path` is the dashboard or anything under it. */
export function isDashPath(path: string, dashPath: string): boolean {
  return path === dashPath || path.startsWith(`${dashPath}/`);
}

type PanelId = "totals" | "timeline" | "latency" | "tools" | "clients" | "auth" | "countries" | "errors";

/** The fixed SQL per panel. Every query reads only `dataset` and ends in FORMAT JSON. */
export function dashQueries(dataset: string, range: DashRange): Record<PanelId, string> {
  const r = DASH_RANGES[range];
  const since = `timestamp > now() - INTERVAL '${r.hours}' HOUR`;
  const bucket = `toStartOfInterval(timestamp, INTERVAL '${r.bucketHours}' HOUR)`;
  const calls = "sum(_sample_interval) AS calls";
  const breakdown = (col: string) =>
    `SELECT ${col} AS k, ${calls} FROM ${dataset} WHERE ${since} GROUP BY k ORDER BY calls DESC LIMIT 10 FORMAT JSON`;
  return {
    totals:
      `SELECT ${calls}, sumIf(_sample_interval, blob3 != 'ok') AS not_ok, ` +
      `sumIf(_sample_interval, blob3 = 'rate_limited') AS rate_limited, ` +
      `quantileExactWeighted(0.95)(double1, _sample_interval) AS p95_ms, count(DISTINCT index1) AS callers ` +
      `FROM ${dataset} WHERE ${since} FORMAT JSON`,
    timeline:
      `SELECT ${bucket} AS t, blob3 AS status, ${calls} FROM ${dataset} WHERE ${since} ` +
      `GROUP BY t, status ORDER BY t FORMAT JSON`,
    latency:
      `SELECT ${bucket} AS t, quantileExactWeighted(0.5)(double1, _sample_interval) AS p50_ms, ` +
      `quantileExactWeighted(0.95)(double1, _sample_interval) AS p95_ms FROM ${dataset} WHERE ${since} ` +
      `GROUP BY t ORDER BY t FORMAT JSON`,
    tools:
      `SELECT blob2 AS tool, ${calls}, sumIf(_sample_interval, blob3 != 'ok') AS not_ok, ` +
      `quantileExactWeighted(0.5)(double1, _sample_interval) AS p50_ms, ` +
      `quantileExactWeighted(0.95)(double1, _sample_interval) AS p95_ms, ` +
      `sumIf(_sample_interval, double2 >= 0) AS lists, sumIf(double2 * _sample_interval, double2 >= 0) AS items ` +
      `FROM ${dataset} WHERE ${since} GROUP BY tool ORDER BY calls DESC LIMIT 20 FORMAT JSON`,
    clients: breakdown("blob5"),
    auth: breakdown("blob7"),
    countries: breakdown("blob8"),
    errors:
      `SELECT blob2 AS tool, blob3 AS status, blob4 AS code, ${calls} FROM ${dataset} ` +
      `WHERE ${since} AND blob3 != 'ok' GROUP BY tool, status, code ORDER BY calls DESC LIMIT 10 FORMAT JSON`,
  };
}

type Row = Record<string, unknown>;
type PanelResult = { rows: Row[] } | { error: string };

async function runQuery(env: Env, sql: string, log: DashLog): Promise<PanelResult> {
  try {
    const res = await env.METRICS_PROXY!.fetch("https://metrics-proxy/", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.DASH_PROXY_KEY}`, "Content-Type": "text/plain" },
      body: sql,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      log("dash.query_failed", { status: res.status, detail });
      return { error: `metrics proxy answered ${res.status}` };
    }
    const body = (await res.json()) as { data?: unknown };
    return { rows: Array.isArray(body.data) ? (body.data as Row[]) : [] };
  } catch (err) {
    log("dash.query_failed", { error: err instanceof Error ? err.message : String(err) });
    return { error: "metrics proxy unreachable" };
  }
}

/** ClickHouse JSON quotes 64-bit numbers; NaN (quantile over no rows) becomes null. */
function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
}

/** Bucket time from AE (`YYYY-MM-DD hh:mm:ss`, UTC) to epoch ms. */
function bucketMs(v: unknown): number | null {
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(str(v));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function fmtInt(n: number | null): string {
  return n === null ? "–" : Math.round(n).toLocaleString("en-US");
}

function fmtMs(n: number | null): string {
  return n === null ? "–" : `${Math.round(n).toLocaleString("en-US")} ms`;
}

const TZ = "Asia/Ho_Chi_Minh";

function fmtBucket(ms: number, bucketHours: number): string {
  const opts: Intl.DateTimeFormatOptions =
    bucketHours >= 24
      ? { timeZone: TZ, day: "2-digit", month: "short" }
      : { timeZone: TZ, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false };
  return new Intl.DateTimeFormat("en-GB", opts).format(new Date(ms));
}

/** Every bucket start in the range, oldest first (AE aligns 1h/6h/24h buckets to UTC epoch multiples). */
function bucketStarts(now: number, range: DashRange): number[] {
  const r = DASH_RANGES[range];
  const size = r.bucketHours * 3_600_000;
  const last = Math.floor(now / size) * size;
  const first = Math.floor((now - r.hours * 3_600_000) / size) * size;
  const out: number[] = [];
  for (let t = first; t <= last; t += size) out.push(t);
  return out;
}

const STATUS_ORDER = ["ok", "invalid_input", "error", "unauthorized", "forbidden", "rate_limited"];

function stackedBars(buckets: number[], byBucket: Map<number, Map<string, number>>, bucketHours: number): string {
  const W = 720;
  const H = 180;
  const PAD_L = 44;
  const PAD_B = 22;
  const plotW = W - PAD_L;
  const plotH = H - PAD_B - 8;
  const totals = buckets.map((b) => [...(byBucket.get(b)?.values() ?? [])].reduce((a, c) => a + c, 0));
  const max = Math.max(1, ...totals);
  const bw = plotW / buckets.length;
  const bars: string[] = [];
  buckets.forEach((b, i) => {
    let y = 8 + plotH;
    const statuses = byBucket.get(b) ?? new Map<string, number>();
    const keys = [...STATUS_ORDER, ...[...statuses.keys()].filter((k) => !STATUS_ORDER.includes(k))];
    for (const k of keys) {
      const v = statuses.get(k) ?? 0;
      if (v <= 0) continue;
      const h = (v / max) * plotH;
      y -= h;
      const cls = STATUS_ORDER.includes(k) ? k : "other";
      bars.push(
        `<rect class="s-${cls}" x="${(PAD_L + i * bw + bw * 0.12).toFixed(1)}" y="${y.toFixed(1)}" ` +
          `width="${Math.max(1, bw * 0.76).toFixed(1)}" height="${h.toFixed(1)}"><title>${escapeHtml(
            `${fmtBucket(b, bucketHours)} · ${k}: ${fmtInt(v)}`,
          )}</title></rect>`,
      );
    }
  });
  return svgFrame(W, H, PAD_L, plotH, max, fmtInt, buckets, bucketHours, bars.join(""));
}

function lineChart(buckets: number[], series: { name: string; cls: string; values: Map<number, number> }[], bucketHours: number): string {
  const W = 720;
  const H = 180;
  const PAD_L = 44;
  const plotW = W - PAD_L;
  const plotH = H - 22 - 8;
  const max = Math.max(1, ...series.flatMap((s) => [...s.values.values()]));
  const step = buckets.length > 1 ? plotW / (buckets.length - 1) : plotW;
  const paths = series.map((s) => {
    let d = "";
    let pen = false;
    buckets.forEach((b, i) => {
      const v = s.values.get(b);
      if (v === undefined) {
        pen = false;
        return;
      }
      const x = PAD_L + i * step;
      const y = 8 + plotH - (v / max) * plotH;
      d += `${pen ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
      pen = true;
    });
    return d ? `<path class="l-${s.cls}" d="${d}" fill="none" stroke-width="2"/>` : "";
  });
  return svgFrame(W, H, PAD_L, plotH, max, (n) => `${fmtInt(n)}`, buckets, bucketHours, paths.join(""));
}

function svgFrame(
  W: number,
  H: number,
  padL: number,
  plotH: number,
  max: number,
  fmt: (n: number) => string,
  buckets: number[],
  bucketHours: number,
  body: string,
): string {
  const grid = [0, 0.5, 1]
    .map((f) => {
      const y = (8 + plotH - f * plotH).toFixed(1);
      return `<line class="grid" x1="${padL}" x2="${W}" y1="${y}" y2="${y}"/><text class="axis" x="${padL - 6}" y="${y}" text-anchor="end" dominant-baseline="middle">${escapeHtml(
        fmt(max * f),
      )}</text>`;
    })
    .join("");
  const idx = buckets.length > 2 ? [0, Math.floor(buckets.length / 2), buckets.length - 1] : buckets.map((_, i) => i);
  const plotW = W - padL;
  const labels = idx
    .map((i) => {
      const x = padL + (buckets.length > 1 ? (i / (buckets.length - 1)) * plotW : plotW / 2);
      const anchor = i === 0 ? "start" : i === buckets.length - 1 ? "end" : "middle";
      return `<text class="axis" x="${x.toFixed(1)}" y="${H - 4}" text-anchor="${anchor}">${escapeHtml(fmtBucket(buckets[i], bucketHours))}</text>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" preserveAspectRatio="none">${grid}${body}${labels}</svg>`;
}

function barList(rows: { label: string; value: number }[], empty: string): string {
  if (rows.length === 0) return `<p class="muted">${escapeHtml(empty)}</p>`;
  const max = Math.max(1, ...rows.map((r) => r.value));
  return `<ul class="bars">${rows
    .map(
      (r) =>
        `<li><span class="lbl">${escapeHtml(r.label || "(none)")}</span><span class="track"><span class="fill" style="width:${(
          (r.value / max) *
          100
        ).toFixed(1)}%"></span></span><span class="val">${fmtInt(r.value)}</span></li>`,
    )
    .join("")}</ul>`;
}

function panelError(p: PanelResult): string {
  return "error" in p ? `<p class="err">Couldn't load: ${escapeHtml(p.error)}</p>` : "";
}

function rowsOf(p: PanelResult): Row[] {
  return "rows" in p ? p.rows : [];
}

export interface DashPageInput {
  config: McpConfig;
  dashPath: string;
  range: DashRange;
  now: number;
  viewer: string | null;
  /** Why data is missing entirely (no binding/key), or null. */
  notice: string | null;
  panels: Partial<Record<PanelId, PanelResult>>;
}

export function renderDashPage(input: DashPageInput): string {
  const { config, dashPath, range, now, viewer, notice, panels } = input;
  const r = DASH_RANGES[range];
  const get = (id: PanelId): PanelResult => panels[id] ?? { rows: [] };

  const t = rowsOf(get("totals"))[0] ?? {};
  const calls = num(t["calls"]);
  const notOk = num(t["not_ok"]);
  const errPct = calls && notOk !== null ? (100 * notOk) / calls : null;
  const tiles = [
    ["Tool calls", fmtInt(calls)],
    ["Not ok", errPct === null ? "–" : `${errPct.toFixed(1)}%`],
    ["p95 latency", fmtMs(calls ? num(t["p95_ms"]) : null)],
    ["Unique callers", fmtInt(num(t["callers"]))],
    ["Rate-limited", fmtInt(num(t["rate_limited"]))],
  ]
    .map(([k, v]) => `<div class="tile"><div class="k">${k}</div><div class="v">${escapeHtml(v)}</div></div>`)
    .join("");

  const buckets = bucketStarts(now, range);
  const byBucket = new Map<number, Map<string, number>>();
  const seenStatus = new Set<string>();
  for (const row of rowsOf(get("timeline"))) {
    const b = bucketMs(row["t"]);
    const v = num(row["calls"]);
    if (b === null || v === null) continue;
    const status = str(row["status"]);
    seenStatus.add(status);
    const m = byBucket.get(b) ?? new Map<string, number>();
    m.set(status, (m.get(status) ?? 0) + v);
    byBucket.set(b, m);
  }
  const legend = [...STATUS_ORDER.filter((s) => seenStatus.has(s)), ...[...seenStatus].filter((s) => !STATUS_ORDER.includes(s))]
    .map((s) => `<span><i class="s-${STATUS_ORDER.includes(s) ? s : "other"}"></i>${escapeHtml(s)}</span>`)
    .join("");

  const p50 = new Map<number, number>();
  const p95 = new Map<number, number>();
  for (const row of rowsOf(get("latency"))) {
    const b = bucketMs(row["t"]);
    if (b === null) continue;
    const a = num(row["p50_ms"]);
    const c = num(row["p95_ms"]);
    if (a !== null) p50.set(b, a);
    if (c !== null) p95.set(b, c);
  }

  const toolRows = rowsOf(get("tools"))
    .map((row) => {
      const n = num(row["calls"]);
      const bad = num(row["not_ok"]);
      const lists = num(row["lists"]);
      const items = num(row["items"]);
      const avgItems = lists ? (items ?? 0) / lists : null;
      return `<tr><td><code>${escapeHtml(str(row["tool"]))}</code></td><td class="n">${fmtInt(n)}</td><td class="n">${
        n && bad !== null ? `${((100 * bad) / n).toFixed(1)}%` : "–"
      }</td><td class="n">${fmtMs(num(row["p50_ms"]))}</td><td class="n">${fmtMs(num(row["p95_ms"]))}</td><td class="n">${
        avgItems === null ? "–" : avgItems.toFixed(1)
      }</td></tr>`;
    })
    .join("");

  const kv = (id: PanelId) =>
    rowsOf(get(id))
      .map((row) => ({ label: str(row["k"]), value: num(row["calls"]) ?? 0 }))
      .filter((x) => x.value > 0);

  const errorRows = rowsOf(get("errors"))
    .map(
      (row) =>
        `<tr><td><code>${escapeHtml(str(row["tool"]))}</code></td><td>${escapeHtml(str(row["status"]))}</td><td>${escapeHtml(
          str(row["code"]) || "–",
        )}</td><td class="n">${fmtInt(num(row["calls"]))}</td></tr>`,
    )
    .join("");

  const rangeLinks = (Object.keys(DASH_RANGES) as DashRange[])
    .map((k) =>
      k === range
        ? `<span class="on">${k}</span>`
        : `<a href="${escapeHtml(`${dashPath}/?range=${k}`)}">${k}</a>`,
    )
    .join("");

  const generated = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(now));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(config.name)} · Dashboard</title>
<style>
  :root { color-scheme: light dark; --fg: #111; --muted: #666; --line: rgba(127,127,127,0.22); --card: rgba(127,127,127,0.07);
    --ok: #8a8f98; --invalid: #d4a017; --error: #d64545; --unauth: #4a7fd6; --forbidden: #7a5cd6; --limited: #c2410c; --other: #999; --p50: #4a7fd6; --p95: #d64545; }
  @media (prefers-color-scheme: dark) { :root { --fg: #eee; --muted: #999; } }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--fg); max-width: 1040px; margin: 32px auto; padding: 0 16px; }
  header { display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; justify-content: space-between; }
  h1 { font-size: 20px; margin: 0; }
  h2 { font-size: 14px; margin: 0 0 10px; }
  .muted, .axis { color: var(--muted); fill: var(--muted); }
  .axis { font-size: 11px; }
  .range a, .range span { padding: 3px 10px; border-radius: 999px; text-decoration: none; color: inherit; border: 1px solid var(--line); margin-left: 4px; }
  .range .on { background: var(--fg); color: Canvas; border-color: var(--fg); }
  .notice, .err { padding: 10px 12px; border-radius: 8px; background: rgba(214,69,69,0.1); }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 18px 0; }
  .tile, .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; }
  .tile .k { color: var(--muted); font-size: 12px; }
  .tile .v { font-size: 22px; font-variant-numeric: tabular-nums; }
  .grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 10px; margin-top: 10px; }
  .card { margin-top: 10px; overflow-x: auto; }
  svg { width: 100%; height: 180px; display: block; }
  svg .grid { stroke: var(--line); }
  .s-ok { fill: var(--ok); background: var(--ok); } .s-invalid_input { fill: var(--invalid); background: var(--invalid); }
  .s-error { fill: var(--error); background: var(--error); } .s-unauthorized { fill: var(--unauth); background: var(--unauth); }
  .s-forbidden { fill: var(--forbidden); background: var(--forbidden); } .s-rate_limited { fill: var(--limited); background: var(--limited); }
  .s-other { fill: var(--other); background: var(--other); }
  .l-p50 { stroke: var(--p50); } .l-p95 { stroke: var(--p95); }
  .legend { display: flex; flex-wrap: wrap; gap: 12px; font-size: 12px; color: var(--muted); margin-top: 6px; }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
  .legend i.l-p50 { background: var(--p50); } .legend i.l-p95 { background: var(--p95); }
  table { border-collapse: collapse; width: 100%; }
  th, td { padding: 6px 8px; border-top: 1px solid var(--line); text-align: left; white-space: nowrap; }
  th { color: var(--muted); font-weight: 500; font-size: 12px; border-top: 0; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
  .bars { list-style: none; margin: 0; padding: 0; }
  .bars li { display: grid; grid-template-columns: 110px 1fr 60px; gap: 8px; align-items: center; padding: 3px 0; }
  .bars .lbl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bars .track { height: 8px; background: var(--line); border-radius: 4px; overflow: hidden; }
  .bars .fill { display: block; height: 100%; background: var(--ok); }
  .bars .val { text-align: right; font-variant-numeric: tabular-nums; }
  footer { margin-top: 24px; font-size: 12px; color: var(--muted); }
</style>
</head>
<body>
<header>
  <div><h1>${escapeHtml(config.name)}</h1><div class="muted">Last ${escapeHtml(r.label)} · ${escapeHtml(generated)} (Vietnam time)</div></div>
  <nav class="range">${rangeLinks}</nav>
</header>
${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}
<section class="tiles">${tiles}</section>
${panelError(get("totals"))}

<div class="card"><h2>Tool calls by status</h2>${panelError(get("timeline"))}${stackedBars(buckets, byBucket, r.bucketHours)}<div class="legend">${legend}</div></div>

<div class="card"><h2>Latency (ms)</h2>${panelError(get("latency"))}${lineChart(
    buckets,
    [
      { name: "p50", cls: "p50", values: p50 },
      { name: "p95", cls: "p95", values: p95 },
    ],
    r.bucketHours,
  )}<div class="legend"><span><i class="l-p50"></i>p50</span><span><i class="l-p95"></i>p95</span></div></div>

<div class="card"><h2>Tools</h2>${panelError(get("tools"))}${
    toolRows
      ? `<table><tr><th>Tool</th><th class="n">Calls</th><th class="n">Not ok</th><th class="n">p50</th><th class="n">p95</th><th class="n">Avg items</th></tr>${toolRows}</table>`
      : `<p class="muted">No tool calls in this range.</p>`
  }</div>

<div class="grid2">
  <div class="card"><h2>Clients</h2>${panelError(get("clients"))}${barList(kv("clients"), "No data.")}</div>
  <div class="card"><h2>Auth</h2>${panelError(get("auth"))}${barList(kv("auth"), "No data.")}</div>
  <div class="card"><h2>Countries</h2>${panelError(get("countries"))}${barList(kv("countries"), "No data.")}</div>
</div>

<div class="card"><h2>Top problems</h2>${panelError(get("errors"))}${
    errorRows
      ? `<table><tr><th>Tool</th><th>Status</th><th>Code</th><th class="n">Calls</th></tr>${errorRows}</table>`
      : `<p class="muted">No failed calls in this range.</p>`
  }</div>

<footer>${escapeHtml(config.slug)} v${escapeHtml(config.version)}${viewer ? ` · signed in as ${escapeHtml(viewer)}` : ""} · data: Analytics Engine <code>${escapeHtml(
    datasetFor(config.slug),
  )}</code>, sampled counts</footer>
</body>
</html>`;
}

type DashLog = (event: string, fields?: Record<string, unknown>) => void;

function isLocalHost(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1";
}

/**
 * Local dev: the request itself is to localhost, or the Worker's public URL
 * is (`.dev.vars` sets MCP_PUBLIC_URL=http://localhost:8788; `wrangler dev`
 * rewrites the request host to the custom domain in `routes`, so the request
 * URL alone can't tell). A deployed MCP can't have a localhost public URL:
 * OAuth would be broken too.
 */
function isLocalDev(request: Request, env: Env): boolean {
  if (isLocalHost(new URL(request.url))) return true;
  try {
    return typeof env.MCP_PUBLIC_URL === "string" && isLocalHost(new URL(env.MCP_PUBLIC_URL));
  } catch {
    return false;
  }
}

const DASH_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-robots-tag": "noindex",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'",
};

function plainPage(status: number, title: string, message: string): Response {
  const html = `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>${escapeHtml(
    title,
  )}</title><body style="font:14px/1.5 sans-serif;max-width:560px;margin:60px auto;padding:0 16px"><h1 style="font-size:18px">${escapeHtml(
    title,
  )}</h1><p>${escapeHtml(message)}</p></body>`;
  return new Response(html, { status, headers: DASH_HEADERS });
}

interface AccessJwtClaims {
  aud?: string | string[];
  iss?: string;
  exp?: number;
  email?: string;
}

/**
 * Checks the Access assertion. Returns the viewer email (or "" when the token
 * carries none) on success, or the Response to send.
 */
export async function checkDashAccess(request: Request, env: Env, now: number): Promise<{ viewer: string } | Response> {
  if (isLocalDev(request, env)) return { viewer: "" };
  if (env.DASH_PUBLIC === "true") return { viewer: "" };
  const team = typeof env.DASH_ACCESS_TEAM === "string" ? env.DASH_ACCESS_TEAM.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "") : "";
  const aud = typeof env.DASH_ACCESS_AUD === "string" ? env.DASH_ACCESS_AUD.trim() : "";
  if (!team || !aud) {
    return plainPage(
      503,
      "Dashboard not configured",
      "Protect this path with a Cloudflare Access app, then set DASH_ACCESS_TEAM and DASH_ACCESS_AUD on the Worker.",
    );
  }
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return plainPage(403, "Access required", "Open this dashboard through its Cloudflare Access sign-in.");
  try {
    const claims = await verifyRs256Jwt<AccessJwtClaims>(token, `https://${team}/cdn-cgi/access/certs`);
    const auds = Array.isArray(claims.aud) ? claims.aud : claims.aud !== undefined ? [claims.aud] : [];
    if (!auds.includes(aud)) throw new Error("wrong audience");
    if (claims.iss !== `https://${team}`) throw new Error("wrong issuer");
    if (typeof claims.exp !== "number" || claims.exp < Math.floor(now / 1000)) throw new Error("expired");
    return { viewer: typeof claims.email === "string" ? claims.email : "" };
  } catch {
    return plainPage(403, "Access required", "Your Access session is invalid or expired. Reload to sign in again.");
  }
}

/** Serves everything under the dashboard path. The caller has checked `isDashPath`. */
export async function handleDash(
  request: Request,
  env: Env,
  config: McpConfig,
  dashPath: string,
  log: DashLog,
  now: number = Date.now(),
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const access = await checkDashAccess(request, env, now);
  if (access instanceof Response) return access;

  const url = new URL(request.url);
  if (url.pathname === dashPath) {
    // Relative: `wrangler dev` rewrites the request host, so url.origin can be wrong locally.
    return new Response(null, { status: 308, headers: { location: `${dashPath}/${url.search}` } });
  }
  if (url.pathname !== `${dashPath}/`) return plainPage(404, "Not found", "No such dashboard page.");

  const rangeParam = url.searchParams.get("range") ?? "7d";
  const range: DashRange = rangeParam in DASH_RANGES ? (rangeParam as DashRange) : "7d";

  let notice: string | null = null;
  const panels: Partial<Record<PanelId, PanelResult>> = {};
  if (!env.METRICS_PROXY || typeof env.METRICS_PROXY.fetch !== "function") {
    notice = "No metrics proxy bound (METRICS_PROXY service binding): showing an empty dashboard.";
  } else if (!env.DASH_PROXY_KEY) {
    notice = "DASH_PROXY_KEY is not set: showing an empty dashboard.";
  } else {
    const queries = dashQueries(datasetFor(config.slug), range);
    const ids = Object.keys(queries) as PanelId[];
    const results = await Promise.all(ids.map((id) => runQuery(env, queries[id], log)));
    ids.forEach((id, i) => (panels[id] = results[i]));
  }

  const html = renderDashPage({ config, dashPath, range, now, viewer: access.viewer || null, notice, panels });
  return new Response(request.method === "HEAD" ? null : html, { headers: DASH_HEADERS });
}
