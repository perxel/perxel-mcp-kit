# Perxel MCP Kit

A public template for building a remote MCP server plus its monitoring
dashboard, 100% on Cloudflare Workers. Every MCP built from it follows the
same checklist: see `STANDARD.md`.

Source-available under the PolyForm Shield 1.0.0 license (`LICENSE`): free
to use and modify, not to resell or offer as a competing service. This is
**not** open source (OSI).

v1 is tested and supported for **Claude only** (claude.ai web, Desktop,
mobile, Claude Code).

## Infrastructure

Read this first. It answers "how many domains, Workers, and what runs where".

### At a glance

Per Cloudflare account: **one subdomain and one Worker per MCP**, plus **one
shared metrics-proxy Worker** (no public URL). No containers, no Pages, no
separate dashboard host, no hosted Inspector.

```
                        ┌──────────── Cloudflare account ─────────────────────────────┐
 Claude ──/mcp────────▶ │  MCP Worker  "<slug>-mcp"   https://<host>                  │
                        │   /mcp  /  /health  OAuth routes                            │
 You (browser) ─/dash─▶ │   /dash  ◀─ Access app (edge sign-in) + JWT re-check        │
   via Access           │     │ service binding METRICS_PROXY (Worker-to-Worker)      │
                        │     ▼                                                       │
                        │  Metrics proxy Worker  "mcp-metrics-proxy"  (no URL)        │
                        │     │ holds the only Analytics Engine read token            │
                        │     ▼                                                       │
                        │  Analytics Engine dataset  mcp_<slug>  (written by /mcp)    │
                        │  KV: OAUTH_KV, CONTENT_KV  ·  Access: sign-in app, /dash app │
                        └─────────────────────────────────────────────────────────────┘
 Your laptop: MCP Inspector (`pnpm dev` / `pnpm inspect`), never deployed.
```

### Hostnames

| Hostname | Worker | Notes |
|---|---|---|
| `<host>`, e.g. `mcp.example.com` or `docs-mcp.example.com` | the MCP Worker | Attached as a Workers **Custom Domain** from `routes` in `wrangler.mcp.jsonc`; `wrangler deploy` creates the DNS record and certificate. Use a one-level subdomain of a zone in your account (covered by the free Universal SSL certificate; `a.b.example.com` needs a paid Advanced Certificate). |

That's the only hostname. `workers_dev` and `preview_urls` are off on both
Workers, so nothing is reachable any other way.

### Paths on `<host>`

| Path | What | Who can reach it |
|---|---|---|
| `/mcp` | The MCP endpoint (`POST`). The URL users paste into Claude is `https://<host>/mcp`. | Public tools: anyone. Private tools: OAuth (Access one-time PIN sign-in, then consent). |
| `/` | Docs page generated from the tool list, with connect steps. | Public |
| `/health` | `{ok, name, slug, version, kit, sources}`; 503 when a required source can't load. | Public |
| `/.well-known/oauth-*`, `/authorize`, `/callback`, `/token`, `/register` | OAuth 2.1 (discovery, DCR/CIMD, PKCE, refresh), sign-in via Cloudflare Access for SaaS (OIDC). | Public (it's the OAuth flow) |
| `/dash` (`DASH_PATH`) | Monitoring dashboard: calls by status, latency p50/p95, per-tool table, clients, auth split, countries, top problems; 24h / 7d / 30d / 90d. Server-rendered HTML + SVG, no client JS. | **Access-protected**: a Cloudflare Access app on `<host>/dash` signs you in at the edge, and the Worker re-verifies the `Cf-Access-Jwt-Assertion` (signature, audience, issuer, expiry). Not configured → 503; no or bad token → 403. |

`DASH_PATH` is configurable (`/dash` default, any path like `/ops/metrics`,
or `off`). It can't be `/` or shadow an MCP route. If you change it, change
the Access app's path to match.

### Workers

| Worker | Config | Count | What it holds |
|---|---|---|---|
| `<slug>-mcp` (template name `example-mcp`) | `wrangler.mcp.jsonc` | one per MCP | The MCP, OAuth, docs, `/health`, `/dash`. Bindings: `OAUTH_KV`, `CONTENT_KV`, `METRICS` (Analytics Engine `mcp_<slug>`), two rate limiters, `METRICS_PROXY` (service binding). |
| `mcp-metrics-proxy` | `wrangler.proxy.jsonc` | **one per Cloudflare account**, shared | The only Analytics Engine read token (`CF_API_TOKEN`, account-wide by Cloudflare's design). Maps each MCP's key to its own dataset (`PROXY_KEYS`) and rejects any SQL that reads another dataset. No public URL. |

Why a separate proxy at all: an Analytics Engine token can't be scoped to one
dataset. If every MCP Worker held it, one compromised MCP could read every
other MCP's metrics. With the proxy, an MCP Worker holds only its own key, which
can only read `mcp_<slug>`.

### Cloudflare Access (Zero Trust)

| Access app | Type | Count | Used for |
|---|---|---|---|
| MCP sign-in | **SaaS, OIDC**. Redirect URI `https://<host>/callback`; login method: email one-time PIN (or another IdP) | one per MCP | Signing in users of private tools. Gives the five `ACCESS_*` secrets. |
| Dashboard | **Self-hosted**, domain `<host>`, path `dash` | one per MCP | Who can open `/dash`. Policy: allow the emails that should see metrics. Its **AUD tag** goes in `DASH_ACCESS_AUD`. |

Seats: sign-in users and dashboard viewers share Zero Trust's 50 free users
across all MCPs in the account, then about $7/user/month.

### What is deliberately *not* deployed

- **MCP Inspector.** It's a Node (Express) app, not a static site: its
  browser UI talks to its own backend (`/api/mcp/connect`, `/api/mcp/send`,
  and an open `/api/fetch` proxy), so Pages can't host it. Workers can't run
  it either, and it hardcodes root paths (`/assets`, `/api`), so it can't sit
  under `/inspector`. Hosting it would take a container plus an Access app,
  just to expose a generic fetch proxy. Run it locally instead:
  `pnpm dev` (against local) or `pnpm inspect https://<host>/mcp --allow-remote`
  (against production, on purpose).
- **Grafana.** Earlier versions ran Grafana in a Cloudflare Container on
  a separate dashboard host: one more Worker and a container per MCP, cold
  starts, and a Docker build. A fixed set of panels covers "is this MCP
  healthy and used", so the dashboard is now part of the MCP Worker. If you
  really want ad-hoc querying, Grafana is an add-on pointed at the
  same proxy (give the proxy a URL only for that case).
- **Cloudflare Pages.** Nothing here is a static site. Cloudflare also steers
  new projects to Workers (with static assets) rather than Pages.

### What wrangler does and doesn't do

| Wrangler CLI | Cloudflare dashboard (or API with a token) |
|---|---|
| Create KV namespaces, set secrets, deploy both Workers, attach the custom domain (`routes` + `custom_domain`), service binding, Analytics Engine dataset (created on first write), rate limiters, `wrangler tail` | Access apps and the Analytics Engine read token (both done by `pnpm setup:cloudflare` through the API); Workers Paid plan; enabling Zero Trust the first time |

### Costs (checked 2026-09-30)

- Workers Paid, $5/month per account: covers every MCP and the proxy at small scale (10M requests, 30M CPU-ms included).
- Zero Trust: 50 free seats shared, then about $7/user/month.
- No container cost.
- LLM tokens are paid by the user's Claude subscription, not by the MCP.

## What's inside

```
STANDARD.md          SSOT checklist: protocol, tools, auth, limits, metrics row, monitoring, tests, costs
kit/                 owned by the kit; clones never edit (updated via pnpm kit:update)
  core/              gate, OAuth + Access sign-in, consent page, rate limit, metrics, logs, health,
                     docs page, dashboard (dash.ts), static JSON source + search
  metrics-proxy/     shared Worker holding the only Analytics Engine token; scopes each key to one dataset
  testing/           protocol test, gate tests, eval runner, inspect launcher
  update/            the kit:update script
  setup/             the setup:cloudflare script (Cloudflare account setup from one global API key)
src/tools/           small generic example (one public, one private tool)
mcp.config.ts        example config
evals/               example questions
wrangler.mcp.jsonc   the MCP Worker (one per MCP)
wrangler.proxy.jsonc the metrics proxy (one per account)
```

## Create a new MCP from the template

1. **Use the template.** On GitHub: Use this template → create your repo
   (e.g. `docs-mcp`, `shop-mcp`), then clone it.
2. **Install.** `pnpm install` (Node 22, pnpm 10.22.0).
3. **Set `mcp.config.ts`.** `slug` (`[a-z0-9-]`; gives the dataset
   `mcp_<slug>` with `-` → `_`), `name`, `version`, `description`, `scopes`
   (every private tool's scope must be listed), and the `tools` list.
4. **Set `wrangler.mcp.jsonc`.** `name` (`<slug>-mcp`), the `routes` pattern
   and `MCP_PUBLIC_URL` (same host, e.g. `mcp.example.com` and
   `https://mcp.example.com`), the dataset name, unique rate-limiter
   `namespace_id`s, and `CONTENT_URL` if you use a static source. Copy
   `.dev.vars.example` to `.dev.vars` for local dev.
5. **Write tools.** Add files in `src/tools/` with `defineTool` from
   `kit/core/tool.ts`: `name` (snake_case), `title`, `description` (what it
   returns, units, freshness, limits), `access: "public" | "private"` (plus a
   `scope` when private), a zod `inputSchema`, and `execute(input, ctx)`.
   Keep the token rules from `STANDARD.md`: list/search tools return compact
   items only (title, slug, excerpt, URL, category, never full text), full
   text comes only from a detail tool for one item, every list has a `limit`
   (default 5, max 20), no "dump everything" tool. Errors: throw
   `new ToolError("not_found" | "bad_input" | "upstream" | "unavailable", msg)`;
   anything else becomes `"Internal error"`.
6. **Tests.** `pnpm typecheck && pnpm test`: unit tests per tool, the
   protocol test (runs against your own config), gate tests (200/401/403),
   dashboard and proxy tests.
7. **Evals.** Edit `evals/questions.md` (one `##` question: `- tool:` lines
   with JSON args, `- expect:` lines with facts that must appear), then
   `pnpm eval --url http://localhost:8788/mcp` against `pnpm dev`.
8. **Clones never edit `kit/`.** Kit fixes arrive via `pnpm kit:update`.

### Content source (static JSON)

For a site-backed MCP (e.g. an MCP over your own website), the site publishes
one JSON file at build time and the MCP reads it:

- The file must be at a **public URL** (e.g. `https://example.com/content.json`),
  set as `CONTENT_URL`. The Worker has no filesystem, so a file in the repo
  isn't read at runtime.
- Recommended shape and search rules: `STANDARD.md` → "Static JSON source".
- In `src/`, create the source once at module level and pass it to both the
  tools and `/health`:

```ts
// src/content.ts
import { z } from "zod";
import { createStaticSource } from "../kit/core/static-source.js";
export const content = createStaticSource({
  name: "content",
  url: (env) => env.CONTENT_URL as string,
  kvKey: "content",
  parse: (json) => Content.parse(json), // your zod schema
});

// src/index.ts
export default createWorker(config, { sources: { content } });
```

- Loading order: fresh memory (about 10 min) → conditional fetch
  (`If-None-Match`) → stale memory → `CONTENT_KV` last-good copy → a clear
  "unavailable" error. `/health` loads the source too, so it reports what a
  tool call would get (`memory`, `fetch`, `kv-fallback`, or `empty` → 503).
- Content changes show up within about 10 minutes of the site deploy, with
  no MCP redeploy.

## Local development

| Command | What |
|---|---|
| `pnpm dev` | `wrangler dev` on `http://localhost:8788` (MCP at `/mcp`, dashboard at `/dash/`), plus the Inspector UI on `http://localhost:8002` pointed at the local `/mcp`. |
| `pnpm inspect` | The Inspector alone, against local by default. `pnpm inspect https://<host>/mcp --allow-remote` inspects production; without the flag it refuses. |
| `pnpm eval --url http://localhost:8788/mcp` | Eval questions; also refuses non-local URLs without `--allow-remote`. |
| `pnpm typecheck && pnpm test` | Must pass after every change. |

The local dashboard skips the Access check (`MCP_PUBLIC_URL` is localhost in
`.dev.vars`). It shows an empty page with a notice unless the proxy runs too:
`wrangler dev -c wrangler.mcp.jsonc -c wrangler.proxy.jsonc` with
`DASH_PROXY_KEY`, `CF_API_TOKEN` and `PROXY_KEYS` in `.dev.vars` (that queries
the real Analytics Engine, so use a real read token only when you need to).

## Deploy

Never deploy, `secret put`, or create resources from a dev machine without
the owner's approval (`STANDARD.md` → Dev rules).

### One command: `pnpm setup:cloudflare`

The only input is the account's **Global API Key** (Cloudflare → My Profile →
API Tokens → Global API Key) and the login email, in `.dev.vars` (gitignored)
or the environment:

```
CF_EMAIL="you@example.com"
CF_GLOBAL_API_KEY="..."
```

Set `name`, `routes`, `MCP_PUBLIC_URL` and the `mcp_<slug>` dataset in
`wrangler.mcp.jsonc`, then:

```
pnpm setup:cloudflare --dry-run     # reads only, prints what it would do
pnpm setup:cloudflare               # does it, deploys, checks /health
```

Flags: `--emails a@x.com,b@x.com` (who may sign in and see the dashboard;
default: the login email), `--policy "<name>"` (reuse an existing reusable Access
policy by name; default `MCP access`), `--no-deploy`.

It is idempotent (looks first, creates only what is missing, safe to re-run) and
drives wrangler with the same key, so no `wrangler login` is needed. It does:

| Step | What |
|---|---|
| Account | Finds the account; fills `CF_ACCOUNT_ID` in `wrangler.proxy.jsonc` |
| Zero Trust | Reads the team domain into `DASH_ACCESS_TEAM` |
| Access policy | Creates (or reuses) one reusable *allow* policy for the emails |
| Access apps | Creates the SaaS OIDC sign-in app (`https://<host>/callback`) and the self-hosted dashboard app (`<host>/dash`), attaches the policy, fills `DASH_ACCESS_AUD` |
| KV | Creates `<worker>-OAUTH_KV` and `<worker>-CONTENT_KV`, fills their ids |
| Rate limits | Picks `namespace_id`s no other Worker in the account uses |
| Metrics proxy | Deploys `mcp-metrics-proxy` if absent; creates the Analytics Read token and sets `CF_API_TOKEN` |
| Secrets | `IP_HASH_SALT`, `COOKIE_ENCRYPTION_KEY`, the five `ACCESS_*`, `DASH_PROXY_KEY` |
| Proxy keys | Keeps every MCP's key hash in a `mcp-kit-registry` KV namespace and rebuilds the full `PROXY_KEYS` map from it, so adding an MCP never drops another |
| Deploy | `wrangler deploy`, then waits for `/health` |

One thing it cannot do: **enable Zero Trust on an account for the first time**
(one click, Zero Trust → Get started, free plan). It stops with that message
if it is off. Also: Cloudflare shows a SaaS app's client secret only when the
app is created, so if `ACCESS_CLIENT_SECRET` is ever lost, delete the sign-in
Access app and re-run.

The global key is all-powerful: keep it in `.dev.vars` only, never commit it,
and rotate it if it leaks. The Worker never reads it.

### Manual steps (what the script automates)

Only needed to understand or repair a setup by hand. Run `pnpm exec wrangler
login` first (it opens a browser).

### Once per Cloudflare account (the first MCP does this)

1. **Workers Paid plan** ($5/month). Don't run production on free (its 10 ms CPU cap per request is a real risk).
2. **Analytics Engine read token** (dashboard → My Profile → API Tokens →
   Create: *Account → Account Analytics → Read*, this account only).
3. **Metrics proxy.** Set `CF_ACCOUNT_ID` in `wrangler.proxy.jsonc`, then:
   ```
   pnpm exec wrangler secret put -c wrangler.proxy.jsonc CF_API_TOKEN
   pnpm exec wrangler secret put -c wrangler.proxy.jsonc PROXY_KEYS   # full JSON map, see below
   pnpm exec wrangler deploy -c wrangler.proxy.jsonc
   ```
4. **Zero Trust team domain** (Zero Trust → Settings → team name,
   `<team>.cloudflareaccess.com`) goes in every MCP's `DASH_ACCESS_TEAM`.

### Per MCP

1. **KV.** `pnpm exec wrangler kv namespace create OAUTH_KV` and
   `... CONTENT_KV`; paste the ids into `wrangler.mcp.jsonc`.
2. **Access sign-in app** (Zero Trust → Access → Applications → Add →
   SaaS → OIDC). Redirect URI `https://<host>/callback`; add a policy (e.g.
   email one-time PIN for allowed emails). Note the client ID, client
   secret, token URL, authorization URL and JWKS URL.
3. **Access dashboard app** (Add → Self-hosted). Domain `<host>`, path
   `dash`; policy: the emails allowed to see metrics. Copy its
   **Application Audience (AUD) tag** into `DASH_ACCESS_AUD`.
4. **Proxy key.** Generate one (`openssl rand -hex 32`), hash it
   (`printf %s '<key>' | shasum -a 256`), add `"<hash>": "mcp_<slug>"` to
   the proxy's `PROXY_KEYS` and re-put the **whole** map (a secret put
   replaces the value), then set the key on the MCP:
   `pnpm exec wrangler secret put -c wrangler.mcp.jsonc DASH_PROXY_KEY`.
5. **MCP secrets** (`pnpm exec wrangler secret put -c wrangler.mcp.jsonc <NAME>`):
   `IP_HASH_SALT`, `COOKIE_ENCRYPTION_KEY` (random, `openssl rand -hex 32`),
   `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET`, `ACCESS_TOKEN_URL`,
   `ACCESS_AUTHORIZATION_URL`, `ACCESS_JWKS_URL`, `DASH_PROXY_KEY`.
6. **Deploy.** `pnpm exec wrangler deploy -c wrangler.mcp.jsonc`. The custom
   domain, DNS record and certificate are created here.
7. **Check.**
   - `https://<host>/health` is `ok: true` (and the source shows `fetch`).
   - `https://<host>/` lists the tools.
   - `https://<host>/dash` asks for Access sign-in, then shows panels (empty until the first tool calls).
   - In Claude: Settings → Connectors → Add custom connector → `https://<host>/mcp`. Public tools work at once; a private tool shows a Connect card → Access PIN → Allow → Claude retries.
   - `pnpm exec wrangler tail <slug>-mcp` for live logs.

### Where every value comes from

| Name | Kind | Where it's set | Source |
|---|---|---|---|
| `MCP_PUBLIC_URL` | var | `wrangler.mcp.jsonc` | `https://<host>`; must match `routes` |
| `CONTENT_URL` | var | `wrangler.mcp.jsonc` | the site's public JSON URL (only with a static source) |
| `DASH_PATH` | var | `wrangler.mcp.jsonc` | `/dash` default, or `off` |
| `DASH_ACCESS_TEAM` | var | `wrangler.mcp.jsonc` | Zero Trust team domain (per account) |
| `DASH_ACCESS_AUD` | var | `wrangler.mcp.jsonc` | AUD tag of the `/dash` Access app (per MCP) |
| `IP_HASH_SALT`, `COOKIE_ENCRYPTION_KEY` | secret | MCP | random |
| `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET`, `ACCESS_TOKEN_URL`, `ACCESS_AUTHORIZATION_URL`, `ACCESS_JWKS_URL` | secret | MCP | the Access SaaS/OIDC app |
| `DASH_PROXY_KEY` | secret | MCP | random; its hash goes in `PROXY_KEYS` |
| `CF_ACCOUNT_ID` | var | `wrangler.proxy.jsonc` | dashboard account id |
| `CF_API_TOKEN` | secret | proxy | Account Analytics Read token |
| `PROXY_KEYS` | secret | proxy | `{"<sha256 of each MCP's key>": "mcp_<slug>", ...}` |

## `kit:update`

Pulls the latest `kit/` from the kit repo without touching the clone's own
files (`src/`, `mcp.config.ts`, `evals/`, wrangler configs, `package.json`):

```
pnpm kit:update [ref] [--from <local path>]
```

- Refuses if `git status --porcelain kit/` is not empty (commit first).
- Default source is `kit.json` (`repo` + `ref`, tarball from GitHub);
  `--from` copies from a local checkout.
- Replaces `kit/` entirely, writes `kit/VERSION` as `<ref>@<short sha>`,
  compares `kit/deps.json` against the clone's `package.json` and prints
  any mismatches with the `pnpm add` command to fix them (never edits
  `package.json` automatically), then prints `git diff --stat kit/`.
- Review the diff, run `pnpm typecheck && pnpm test`, commit.
- Clone-owned files the kit changed in a release (wrangler configs,
  `package.json` scripts) are listed in that release's commit message; copy
  those changes by hand.

## Transferring to another Cloudflare account

See `TRANSFER.md`.
