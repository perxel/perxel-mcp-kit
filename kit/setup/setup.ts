import { spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createCfApi, type CfApi } from "./cf-api.js";

/**
 * `pnpm setup:cloudflare`: creates everything an MCP needs on Cloudflare from
 * one global API key (CF_GLOBAL_API_KEY + CF_EMAIL, in the environment or
 * `.dev.vars`). Every step is idempotent: it looks first and only creates what
 * is missing, so it is safe to re-run. See README "Deploy".
 */

// ── pure helpers (unit tested) ─────────────────────────────────────────────

/** Strip // and /* *​/ comments and trailing commas from JSONC, leaving strings intact. */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export interface McpConfig {
  workerName: string;
  host: string;
  dataset: string;
  oauthKvId: string;
  contentKvId: string;
  team: string;
  aud: string;
  dashPublic: boolean;
  namespaceIds: string[];
}

export const isPlaceholder = (v: string | undefined): boolean => !v || v.startsWith("<");

/** Read the fields setup cares about from `wrangler.mcp.jsonc`. */
export function readMcpConfig(text: string): McpConfig {
  const c = JSON.parse(stripJsonc(text)) as {
    name: string;
    routes?: { pattern: string }[];
    vars?: Record<string, string>;
    kv_namespaces?: { binding: string; id: string }[];
    analytics_engine_datasets?: { dataset: string }[];
    ratelimits?: { namespace_id: string }[];
  };
  const host = c.routes?.[0]?.pattern;
  const dataset = c.analytics_engine_datasets?.[0]?.dataset;
  if (!host || !dataset) throw new Error("wrangler.mcp.jsonc needs a routes pattern and an Analytics Engine dataset");
  const kv = (b: string) => c.kv_namespaces?.find((k) => k.binding === b)?.id ?? "";
  return {
    workerName: c.name,
    host,
    dataset,
    oauthKvId: kv("OAUTH_KV"),
    contentKvId: kv("CONTENT_KV"),
    team: c.vars?.["DASH_ACCESS_TEAM"] ?? "",
    aud: c.vars?.["DASH_ACCESS_AUD"] ?? "",
    dashPublic: c.vars?.["DASH_PUBLIC"] === "true",
    namespaceIds: (c.ratelimits ?? []).map((r) => r.namespace_id),
  };
}

/** Replace the value after `"key":` (first match, or the nth with `nth`). */
export function setJsonValue(text: string, key: string, value: string, nth = 0): string {
  const re = new RegExp(`("${key}"\\s*:\\s*)"[^"]*"`, "g");
  let n = 0;
  return text.replace(re, (m, head: string) => (n++ === nth ? `${head}${JSON.stringify(value)}` : m));
}

/** Set a KV namespace id in the `kv_namespaces` entry of `binding`. */
export function setKvId(text: string, binding: string, id: string): string {
  const re = new RegExp(`("binding"\\s*:\\s*"${binding}"\\s*,\\s*"id"\\s*:\\s*)"[^"]*"`);
  return text.replace(re, (_m, head: string) => `${head}${JSON.stringify(id)}`);
}

/** Rate-limit namespace ids must be unique per account: pick `count` free ones at or above `start`. */
export function pickNamespaceIds(mine: string[], used: Set<string>, count = 2, start = 3001): string[] {
  if (mine.length === count && mine.every((id) => /^[1-9]\d*$/.test(id) && !used.has(id)) && new Set(mine).size === count) return mine;
  const out: string[] = [];
  for (let n = start; out.length < count; n++) if (!used.has(String(n))) out.push(String(n));
  return out;
}

/** Merge one MCP into the proxy key map (one entry per dataset; the old key for it is replaced). */
export function mergeProxyKeys(map: Record<string, string>, keyHash: string, dataset: string): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [hash, ds] of Object.entries(map)) if (ds !== dataset) next[hash] = ds;
  next[keyHash] = dataset;
  return next;
}

export function oidcUrls(team: string, clientId: string) {
  const base = `https://${team}/cdn-cgi/access/sso/oidc/${clientId}`;
  return { tokenUrl: `${base}/token`, authorizationUrl: `${base}/authorization`, jwksUrl: `${base}/jwks` };
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Parse `KEY="value"` lines (the `.dev.vars` format). */
export function parseDotVars(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

/** The first non-space, non-comment character before `index`, for comma decisions. */
function prevSignificant(text: string, index: number): string {
  const head = stripJsonc(text.slice(0, index)).trimEnd();
  return head[head.length - 1] ?? "";
}

/** Insert a top-level `"key": value` before the root object's closing brace (no-op when the key exists). */
export function insertTopLevel(text: string, key: string, valueJson: string, comment?: string): string {
  if (new RegExp(`"${key}"\\s*:`).test(stripJsonc(text))) return text;
  const end = text.lastIndexOf("}");
  if (end < 0) throw new Error("wrangler.mcp.jsonc: no closing brace");
  const prev = prevSignificant(text, end);
  const sep = prev === "{" || prev === "," ? "" : ",";
  const head = text.slice(0, end).trimEnd();
  return `${head}${sep}\n${comment ? `  // ${comment}\n` : ""}  "${key}": ${valueJson}\n}${text.slice(end + 1)}`;
}

/** Add an entry to the top-level `ratelimits` array unless one with `name` exists. */
export function insertRateLimit(text: string, name: string, namespaceId: string, limit: number): string {
  if (new RegExp(`"name"\\s*:\\s*"${name}"`).test(text)) return text;
  const start = text.indexOf('"ratelimits"');
  if (start < 0) {
    return insertTopLevel(text, "ratelimits", `[{ "name": "${name}", "namespace_id": "${namespaceId}", "simple": { "limit": ${limit}, "period": 60 } }]`);
  }
  const close = text.indexOf("]", text.indexOf("[", start));
  const prev = prevSignificant(text, close);
  const sep = prev === "[" || prev === "," ? "" : ",";
  const entry = `    {\n      "name": "${name}",\n      // Ask: per-IP requests per minute (ask.limits.perIpPerMinute)\n      "namespace_id": "${namespaceId}",\n      "simple": { "limit": ${limit}, "period": 60 }\n    }`;
  return `${text.slice(0, close).trimEnd()}${sep}\n${entry}\n  ${text.slice(close)}`;
}

/** Add a var to `vars` unless present (then set it). */
export function upsertVar(text: string, key: string, value: string): string {
  if (new RegExp(`"${key}"\\s*:`).test(text)) return setJsonValue(text, key, value);
  const at = text.indexOf("{", text.indexOf('"vars"'));
  if (text.indexOf('"vars"') < 0 || at < 0) return insertTopLevel(text, "vars", JSON.stringify({ [key]: value }));
  return `${text.slice(0, at + 1)}\n    ${JSON.stringify(key)}: ${JSON.stringify(value)},${text.slice(at + 1)}`;
}

/** Hostnames a Turnstile widget must allow: those of the Ask allowed origins, minus localhost. */
export function turnstileDomains(allowedOrigins: string[]): string[] {
  const out = new Set<string>();
  for (const o of allowedOrigins) {
    const h = new URL(o).hostname;
    if (h !== "localhost" && h !== "127.0.0.1") out.add(h);
  }
  return [...out];
}

/** Daily Ask job, 02:17 Vietnam time. */
export const ASK_CRON = "17 19 * * *";

// ── orchestration ──────────────────────────────────────────────────────────

export interface Wrangler {
  /** Run `wrangler <args>`; `stdin` feeds secret values so they never hit argv or logs. */
  run(args: string[], stdin?: string): string;
}

export interface SetupOptions {
  root: string;
  email: string;
  emails: string[]; // who may sign in and see the dashboard
  policyName: string;
  dryRun: boolean;
  deploy: boolean;
  api: CfApi;
  wrangler: Wrangler;
  log: (msg: string) => void;
  fetchImpl?: typeof fetch;
  /** Set when the clone's mcp.config.ts has an `ask` block. */
  ask?: { allowedOrigins: string[]; perIpPerMinute: number };
  /** Reads a secret from the terminal without echo (CLI); absent in tests. */
  promptSecret?: (label: string) => Promise<string>;
}

interface AccessApp {
  id: string;
  type: string;
  name: string;
  domain?: string;
  aud: string;
  policies?: { id: string }[];
  saas_app?: { client_id?: string; redirect_uris?: string[] };
}
interface AccessPolicy {
  id: string;
  name: string;
  reusable?: boolean;
}

const PROXY_WORKER = "mcp-metrics-proxy";
const REGISTRY_TITLE = "mcp-kit-registry";
const REGISTRY_KEY = "proxy-keys";
const SAAS_SCOPES = ["openid", "email", "profile"];

export async function runSetup(o: SetupOptions): Promise<void> {
  const { api, wrangler, log } = o;
  const act = async <T>(desc: string, fn: () => Promise<T> | T, fallback: T): Promise<T> => {
    if (o.dryRun) {
      log(`  [dry-run] would ${desc}`);
      return fallback;
    }
    log(`  ${desc}`);
    return fn();
  };

  const mcpPath = join(o.root, "wrangler.mcp.jsonc");
  const proxyPath = join(o.root, "wrangler.proxy.jsonc");
  let mcpText = readFileSync(mcpPath, "utf8");
  let proxyText = existsSync(proxyPath) ? readFileSync(proxyPath, "utf8") : "";
  const cfg = readMcpConfig(mcpText);
  const cb = `https://${cfg.host}/callback`;
  const dashDomain = `${cfg.host}/dash`;
  const write = () => {
    if (!o.dryRun) {
      writeFileSync(mcpPath, mcpText);
      if (proxyText) writeFileSync(proxyPath, proxyText);
    }
  };

  // 1. Account
  log("1. Account");
  const accounts = await api.request<{ id: string; name: string }[]>("GET", "/accounts");
  if (accounts.length !== 1) {
    throw new Error(`expected one Cloudflare account for this key, found ${accounts.length}: set CLOUDFLARE_ACCOUNT_ID to choose`);
  }
  const account = process.env["CLOUDFLARE_ACCOUNT_ID"] ? { id: process.env["CLOUDFLARE_ACCOUNT_ID"], name: "(from env)" } : accounts[0]!;
  const acc = `/accounts/${account.id}`;
  log(`  ${account.name} (${account.id})`);
  if (proxyText && isPlaceholder(/"CF_ACCOUNT_ID"\s*:\s*"([^"]*)"/.exec(proxyText)?.[1])) {
    proxyText = setJsonValue(proxyText, "CF_ACCOUNT_ID", account.id);
  }

  // 2. Access organization (Zero Trust must have been enabled once for the account)
  log("2. Zero Trust");
  const org = await api.request<{ auth_domain: string }>("GET", `${acc}/access/organizations`).catch((err: unknown) => {
    throw new Error(
      `Zero Trust Access is not enabled on this account (${err instanceof Error ? err.message : String(err)}). Enable it once in the Cloudflare dashboard (Zero Trust → Get started), then re-run.`,
    );
  });
  const team = org.auth_domain;
  log(`  team ${team}`);
  if (cfg.team !== team) mcpText = setJsonValue(mcpText, "DASH_ACCESS_TEAM", team);

  // 3. Policy
  log("3. Access policy");
  const policies = await api.request<AccessPolicy[]>("GET", `${acc}/access/policies`);
  let policy = policies.find((p) => p.name === o.policyName);
  if (policy) log(`  reusing "${o.policyName}"`);
  else {
    policy = await act(
      `create policy "${o.policyName}" for ${o.emails.join(", ")}`,
      () =>
        api.request<AccessPolicy>("POST", `${acc}/access/policies`, {
          name: o.policyName,
          decision: "allow",
          include: o.emails.map((email) => ({ email: { email } })),
        }),
      { id: "(new policy)", name: o.policyName },
    );
  }
  const policyId = policy.id;

  // 4. Access apps
  log("4. Access apps");
  const apps = await api.request<AccessApp[]>("GET", `${acc}/access/apps`);
  const detail = (id: string) => api.request<AccessApp>("GET", `${acc}/access/apps/${id}`);
  const ensurePolicy = async (app: AccessApp, body: Record<string, unknown>) => {
    const full = await detail(app.id);
    if (full.policies?.some((p) => p.id === policyId)) return;
    await act(`attach policy to "${app.name}"`, () => api.request("PUT", `${acc}/access/apps/${app.id}`, { ...body, policies: [{ id: policyId, precedence: 1 }] }), undefined);
  };

  // 4a. SaaS OIDC sign-in app
  let signIn = apps.find((a) => a.type === "saas" && a.saas_app?.redirect_uris?.includes(cb));
  let clientSecret: string | undefined;
  if (signIn) {
    log(`  sign-in app exists ("${signIn.name}")`);
    const saas = (await detail(signIn.id)).saas_app ?? {};
    await ensurePolicy(signIn, {
      type: "saas",
      name: signIn.name,
      app_launcher_visible: false,
      session_duration: "24h",
      saas_app: { auth_type: "oidc", redirect_uris: [cb], grant_types: ["authorization_code"], scopes: SAAS_SCOPES, access_token_lifetime: "5m", ...(saas as object) },
    });
  } else {
    const created = await act(
      "create the OIDC sign-in app",
      () =>
        api.request<AccessApp & { saas_app: { client_id: string; client_secret: string } }>("POST", `${acc}/access/apps`, {
          type: "saas",
          name: `${cfg.workerName} sign-in`,
          app_launcher_visible: false,
          session_duration: "24h",
          policies: [{ id: policyId, precedence: 1 }],
          saas_app: { auth_type: "oidc", redirect_uris: [cb], grant_types: ["authorization_code"], scopes: SAAS_SCOPES, access_token_lifetime: "5m" },
        }),
      { id: "", type: "saas", name: "(new)", aud: "", saas_app: { client_id: "(new)", client_secret: "(new)" } },
    );
    signIn = created;
    clientSecret = (created.saas_app as { client_secret?: string }).client_secret;
  }
  const clientId = signIn.saas_app?.client_id ?? signIn.aud;

  // 4b. Dashboard app (skipped when DASH_PUBLIC is "true": the dashboard is open)
  let dash = apps.find((a) => a.type === "self_hosted" && a.domain === dashDomain);
  const dashBody = (name: string) => ({ type: "self_hosted", name, domain: dashDomain, session_duration: "24h", app_launcher_visible: false });
  if (cfg.dashPublic) {
    log("  DASH_PUBLIC is true: no Access app for the dashboard");
    if (dash) log(`  WARNING: "${dash.name}" still protects ${dashDomain} and would block visitors: delete that Access app`);
  } else if (dash) {
    log(`  dashboard app exists ("${dash.name}")`);
    await ensurePolicy(dash, dashBody(dash.name));
  } else {
    dash = await act(
      `create the dashboard app for ${dashDomain}`,
      () => api.request<AccessApp>("POST", `${acc}/access/apps`, { ...dashBody(`${cfg.workerName} dashboard`), policies: [{ id: policyId, precedence: 1 }] }),
      { id: "", type: "self_hosted", name: "(new)", aud: "(new)" } as AccessApp,
    );
  }
  if (dash && dash.aud !== cfg.aud) mcpText = setJsonValue(mcpText, "DASH_ACCESS_AUD", dash.aud);

  // 5. KV namespaces
  log("5. KV namespaces");
  const kvList = await api.request<{ id: string; title: string }[]>("GET", `${acc}/storage/kv/namespaces?per_page=100`);
  const ensureKv = async (binding: "OAUTH_KV" | "CONTENT_KV", current: string) => {
    if (!isPlaceholder(current)) return log(`  ${binding} ok`);
    const title = `${cfg.workerName}-${binding}`;
    const found = kvList.find((k) => k.title === title);
    const id = found?.id ?? (await act(`create KV ${title}`, async () => (await api.request<{ id: string }>("POST", `${acc}/storage/kv/namespaces`, { title })).id, "(new)"));
    mcpText = setKvId(mcpText, binding, id);
  };
  await ensureKv("OAUTH_KV", cfg.oauthKvId);
  await ensureKv("CONTENT_KV", cfg.contentKvId);

  // 5b. Ask: D1 database, rate limiter, cron (only with an `ask` block in mcp.config.ts)
  if (o.ask) {
    log("5b. Ask bindings");
    const dbName = `${cfg.workerName}-ask`;
    const dbs = await api.request<{ uuid: string; name: string }[]>("GET", `${acc}/d1/database?name=${encodeURIComponent(dbName)}`);
    const dbId =
      dbs.find((d) => d.name === dbName)?.uuid ??
      (await act(`create D1 ${dbName}`, async () => (await api.request<{ uuid: string }>("POST", `${acc}/d1/database`, { name: dbName })).uuid, "(new)"));
    if (!/"binding"\s*:\s*"ASK_DB"/.test(mcpText)) {
      mcpText = insertTopLevel(
        mcpText,
        "d1_databases",
        JSON.stringify([{ binding: "ASK_DB", database_name: dbName, database_id: dbId, migrations_dir: "kit/ask/migrations" }]),
        "Ask conversations (kit/ask/store.ts); migrations in kit/ask/migrations",
      );
    } else if (/"database_id"\s*:\s*"</.test(mcpText)) {
      mcpText = setJsonValue(mcpText, "database_id", dbId);
    }
    mcpText = insertRateLimit(mcpText, "ASK_RATE_LIMITER", "0", o.ask.perIpPerMinute);
    mcpText = insertTopLevel(mcpText, "triggers", JSON.stringify({ crons: [ASK_CRON] }), "Ask daily job: topic labels, retention");
    cfg.namespaceIds = readMcpConfig(mcpText).namespaceIds;
    log(`  ${dbName} (${dbId}), ASK_RATE_LIMITER ${o.ask.perIpPerMinute}/min, cron ${ASK_CRON}`);
  }

  // 6. Rate-limit namespace ids (unique per account)
  log("6. Rate-limit ids");
  const scripts = await api.request<{ id: string }[]>("GET", `${acc}/workers/scripts`);
  const used = new Set<string>();
  for (const s of scripts.filter((s) => s.id !== cfg.workerName)) {
    const settings = await api.request<{ bindings?: { type: string; namespace_id?: string }[] }>("GET", `${acc}/workers/scripts/${s.id}/settings`).catch(() => ({ bindings: [] }));
    for (const b of settings.bindings ?? []) if (b.type === "ratelimit" && b.namespace_id) used.add(b.namespace_id);
  }
  const ids = pickNamespaceIds(cfg.namespaceIds, used, Math.max(2, cfg.namespaceIds.length));
  ids.forEach((id, n) => {
    if (id !== cfg.namespaceIds[n]) mcpText = setJsonValue(mcpText, "namespace_id", id, n);
  });
  log(`  ${ids.join(", ")}${ids.every((id, n) => id === cfg.namespaceIds[n]) ? " (unchanged)" : " (updated in config)"}`);

  write();

  // 7. Metrics proxy (one per account)
  log("7. Metrics proxy");
  const hasProxy = scripts.some((s) => s.id === PROXY_WORKER);
  const proxySecrets = hasProxy ? await secretNames(api, acc, PROXY_WORKER) : new Set<string>();
  if (!hasProxy) await act("deploy mcp-metrics-proxy", () => wrangler.run(["deploy", "-c", "wrangler.proxy.jsonc"]), "");
  else log("  deployed");
  if (!proxySecrets.has("CF_API_TOKEN")) {
    await act("create an Analytics Read token and set CF_API_TOKEN on the proxy", async () => {
      const groups = await api.request<{ id: string; name: string }[]>("GET", "/user/tokens/permission_groups");
      const group = groups.find((g) => g.name === "Account Analytics Read");
      if (!group) throw new Error('permission group "Account Analytics Read" not found');
      const token = await api.request<{ value: string }>("POST", "/user/tokens", {
        name: `${PROXY_WORKER} (analytics read)`,
        policies: [{ effect: "allow", resources: { [`com.cloudflare.api.account.${account.id}`]: "*" }, permission_groups: [{ id: group.id }] }],
      });
      wrangler.run(["secret", "put", "CF_API_TOKEN", "-c", "wrangler.proxy.jsonc"], token.value);
    }, undefined);
  } else log("  CF_API_TOKEN set");

  // 8. Secrets on the MCP Worker
  log("8. MCP secrets");
  const have = await secretNames(api, acc, cfg.workerName);
  const put = async (name: string, value: string) => act(`set ${name}`, () => wrangler.run(["secret", "put", name, "-c", "wrangler.mcp.jsonc"], value), "");
  const rand = () => Array.from(randomBytes(32), (b) => b.toString(16).padStart(2, "0")).join("");
  if (!have.has("IP_HASH_SALT")) await put("IP_HASH_SALT", rand());
  if (!have.has("COOKIE_ENCRYPTION_KEY")) await put("COOKIE_ENCRYPTION_KEY", rand());
  const urls = oidcUrls(team, clientId);
  const accessValues: Record<string, string | undefined> = {
    ACCESS_CLIENT_ID: clientId,
    ACCESS_CLIENT_SECRET: clientSecret,
    ACCESS_TOKEN_URL: urls.tokenUrl,
    ACCESS_AUTHORIZATION_URL: urls.authorizationUrl,
    ACCESS_JWKS_URL: urls.jwksUrl,
  };
  for (const [name, value] of Object.entries(accessValues)) {
    if (!value) {
      if (!have.has(name)) throw new Error(`${name} is missing and Cloudflare only shows the client secret when the app is created: delete the "${signIn.name}" Access app and re-run setup`);
      continue;
    }
    // Non-secret values are written once; the client secret only when the app was just created.
    if (name === "ACCESS_CLIENT_SECRET" || !have.has(name)) await put(name, value);
  }

  // 8b. Ask: conversation review behind Access, Turnstile widget, secrets
  if (o.ask) {
    log("8b. Ask");
    const convDomain = `${cfg.host}/dash/conversations`;
    let conv = apps.find((a) => a.type === "self_hosted" && a.domain === convDomain);
    const convBody = (name: string) => ({ type: "self_hosted", name, domain: convDomain, session_duration: "24h", app_launcher_visible: false });
    if (conv) {
      log(`  conversations app exists ("${conv.name}")`);
      await ensurePolicy(conv, convBody(conv.name));
    } else {
      conv = await act(
        `create the Access app for ${convDomain} (always private, even with DASH_PUBLIC)`,
        () => api.request<AccessApp>("POST", `${acc}/access/apps`, { ...convBody(`${cfg.workerName} Ask conversations`), policies: [{ id: policyId, precedence: 1 }] }),
        { id: "", type: "self_hosted", name: "(new)", aud: "(new)" } as AccessApp,
      );
    }
    if (conv.aud && !mcpText.includes(`"ASK_DASH_ACCESS_AUD": ${JSON.stringify(conv.aud)}`)) {
      mcpText = upsertVar(mcpText, "ASK_DASH_ACCESS_AUD", conv.aud);
      if (cfg.dashPublic && !/"DASH_ACCESS_TEAM"\s*:\s*"[^<]/.test(mcpText)) mcpText = setJsonValue(mcpText, "DASH_ACCESS_TEAM", team);
      write();
    }

    const widgetName = `${cfg.workerName} Ask`;
    const domains = turnstileDomains(o.ask.allowedOrigins);
    const widgets = await api.request<{ sitekey: string; name: string; domains: string[] }[]>("GET", `${acc}/challenges/widgets?per_page=100`);
    let widget = widgets.find((w) => w.name === widgetName);
    let widgetSecret: string | undefined;
    if (widget) {
      log(`  Turnstile widget exists (sitekey ${widget.sitekey})`);
      if (domains.some((d) => !widget!.domains.includes(d))) {
        await act(`add ${domains.join(", ")} to the Turnstile widget`, () =>
          api.request("PUT", `${acc}/challenges/widgets/${widget!.sitekey}`, { name: widgetName, domains, mode: "managed" }), undefined);
      }
      if (!have.has("TURNSTILE_SECRET")) {
        widgetSecret = (await api.request<{ secret?: string }>("GET", `${acc}/challenges/widgets/${widget.sitekey}`)).secret;
      }
    } else {
      const created = await act(
        `create a Turnstile widget for ${domains.join(", ")}`,
        () => api.request<{ sitekey: string; secret: string; name: string; domains: string[] }>("POST", `${acc}/challenges/widgets`, { name: widgetName, domains, mode: "managed" }),
        { sitekey: "(new)", secret: "", name: widgetName, domains },
      );
      widget = created;
      widgetSecret = created.secret;
    }
    log(`  Turnstile site key for the website: ${widget.sitekey}`);
    if (widgetSecret) await put("TURNSTILE_SECRET", widgetSecret);
    if (!have.has("ASK_SESSION_SECRET")) await put("ASK_SESSION_SECRET", rand());
    if (!have.has("OPENROUTER_API_KEY")) {
      const key = process.env["OPENROUTER_API_KEY"] || (o.promptSecret && !o.dryRun ? await o.promptSecret("OpenRouter API key (set a credit limit on it first)") : "");
      if (key) await put("OPENROUTER_API_KEY", key);
      else log("  OPENROUTER_API_KEY not set: run `pnpm exec wrangler secret put OPENROUTER_API_KEY -c wrangler.mcp.jsonc`");
    }
    await act("apply the Ask D1 migrations", () => wrangler.run(["d1", "migrations", "apply", "ASK_DB", "--remote", "-c", "wrangler.mcp.jsonc"]), "");
  }

  // 9. Dashboard proxy key + the shared key registry
  log("9. Dashboard proxy key");
  const registryId = await ensureRegistry(api, acc, kvList, o);
  const raw = registryId !== "(new)" ? await api.requestText("GET", `${acc}/storage/kv/namespaces/${registryId}/values/${REGISTRY_KEY}`) : null;
  const registry = raw ? (JSON.parse(raw) as Record<string, string>) : {};
  const registered = Object.values(registry).includes(cfg.dataset);
  if (have.has("DASH_PROXY_KEY") && registered) log("  key set and registered");
  else {
    const key = rand();
    await put("DASH_PROXY_KEY", key);
    const merged = mergeProxyKeys(registry, sha256(key), cfg.dataset);
    await act("register the key hash and update PROXY_KEYS on the proxy", async () => {
      wrangler.run(["secret", "put", "PROXY_KEYS", "-c", "wrangler.proxy.jsonc"], JSON.stringify(merged));
      await api.requestText("PUT", `${acc}/storage/kv/namespaces/${registryId}/values/${REGISTRY_KEY}`, JSON.stringify(merged));
    }, undefined);
  }

  // 10. Deploy + smoke check
  log("10. Deploy");
  if (!o.deploy) log("  skipped (--no-deploy)");
  else {
    await act("deploy the MCP Worker", () => wrangler.run(["deploy", "-c", "wrangler.mcp.jsonc"]), "");
    if (!o.dryRun) await smoke(cfg.host, o);
  }
  log("Done.");
}

async function secretNames(api: CfApi, acc: string, worker: string): Promise<Set<string>> {
  try {
    const list = await api.request<{ name: string }[]>("GET", `${acc}/workers/scripts/${worker}/secrets`);
    return new Set(list.map((s) => s.name));
  } catch {
    return new Set(); // Worker not deployed yet
  }
}

async function ensureRegistry(api: CfApi, acc: string, list: { id: string; title: string }[], o: SetupOptions): Promise<string> {
  const found = list.find((k) => k.title === REGISTRY_TITLE);
  if (found) return found.id;
  return o.dryRun
    ? "(new)"
    : (await api.request<{ id: string }>("POST", `${acc}/storage/kv/namespaces`, { title: REGISTRY_TITLE })).id;
}

async function smoke(host: string, o: SetupOptions): Promise<void> {
  const f = o.fetchImpl ?? fetch;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await f(`https://${host}/health`);
      if (res.ok) {
        o.log(`  https://${host}/health ok`);
        return;
      }
    } catch {
      // DNS/certificate may need a few seconds after the first deploy
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  o.log(`  warning: https://${host}/health did not answer ok yet`);
}

// ── CLI ────────────────────────────────────────────────────────────────────

/** Read a line from the terminal without echoing it. */
export function promptHidden(label: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(`${label} (input hidden, empty to skip): `);
    let value = "";
    const onData = (buf: Uint8Array) => {
      for (const ch of new TextDecoder().decode(buf)) {
        if (ch === "\n" || ch === "\r" || ch === "\u0004") {
          stdin.off("data", onData);
          if (stdin.isTTY) stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write("\n");
          return resolve(value.trim());
        }
        if (ch === "\u0003") process.exit(130);
        value = ch === "\u007f" ? value.slice(0, -1) : value + ch;
      }
    };
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

/** The clone's `ask` block (from mcp.config.ts), or undefined when Ask is off. */
async function readAskConfig(root: string): Promise<SetupOptions["ask"]> {
  const path = join(root, "mcp.config.ts");
  if (!existsSync(path)) return undefined;
  const mod = (await import(pathToFileURL(path).href)) as { default?: { ask?: { allowedOrigins: string[]; limits?: { perIpPerMinute?: number } } } };
  const ask = mod.default?.ask;
  return ask ? { allowedOrigins: ask.allowedOrigins, perIpPerMinute: ask.limits?.perIpPerMinute ?? 6 } : undefined;
}

export function realWrangler(root: string, env: NodeJS.ProcessEnv): Wrangler {
  return {
    run(args, stdin) {
      const r = spawnSync("pnpm", ["exec", "wrangler", ...args], { cwd: root, env, input: stdin, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`wrangler ${args[0]} ${args[1] ?? ""} failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | ")}`);
      return r.stdout;
    },
  };
}

function parseArgs(argv: string[]) {
  const out = { dryRun: false, deploy: true, emails: [] as string[], policy: "MCP access" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--no-deploy") out.deploy = false;
    else if (a === "--emails") out.emails = (argv[++i] ?? "").split(",").map((e) => e.trim()).filter(Boolean);
    else if (a === "--policy") out.policy = argv[++i] ?? out.policy;
    else throw new Error(`setup: unknown flag ${a}`);
  }
  return out;
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  try {
    const root = process.cwd();
    const dotVars = existsSync(join(root, ".dev.vars")) ? parseDotVars(readFileSync(join(root, ".dev.vars"), "utf8")) : {};
    const key = process.env["CF_GLOBAL_API_KEY"] ?? dotVars["CF_GLOBAL_API_KEY"];
    const email = process.env["CF_EMAIL"] ?? dotVars["CF_EMAIL"];
    if (!key || !email) throw new Error("setup: set CF_GLOBAL_API_KEY and CF_EMAIL (environment or .dev.vars)");
    const args = parseArgs(process.argv.slice(2));
    const env: NodeJS.ProcessEnv = { ...process.env, CLOUDFLARE_API_KEY: key, CLOUDFLARE_EMAIL: email };
    delete env["CLOUDFLARE_API_TOKEN"];
    await runSetup({
      root,
      email,
      emails: args.emails.length > 0 ? args.emails : [email],
      policyName: args.policy,
      dryRun: args.dryRun,
      deploy: args.deploy,
      api: createCfApi({ email, key }),
      wrangler: realWrangler(root, env),
      log: (m) => console.log(m),
      ask: await readAskConfig(root),
      promptSecret: promptHidden,
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
