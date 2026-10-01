# Plan 001: Perxel MCP Kit v1

Status: built (kit released as v0.0.1), not deployed
Written: 2026-09-30
Scope of v1: Claude only. ChatGPT and Gemini are roadmap items (see the end).
History: the task list and build notes that used to sit in `001-mcp-kit-v1-tasks.md` and `001-notes.md` are folded into "Build result" below. The code, `README.md` and `STANDARD.md` are the source of truth for how things work now.

## Product summary

Perxel runs MCP as a managed service (hosted and maintained, SaaS-like), built on the Perxel MCP Kit.

- **Product:** a remote MCP server for the client's data.
- **Input:** a static JSON file (small content sites) or API endpoints (larger or changing data). For WordPress clients, a generic Perxel WordPress connector plugin exposes custom post types as a clean read API (roadmap).
- **Usage:** any AI app that accepts an MCP URL. **v1 is tested and supported for Claude only**; ChatGPT and Gemini Enterprise are on the roadmap, and the consumer Gemini app is US-only (Google's restriction). Public tools will likely work elsewhere, but only Claude is promised until the others are tested.
- **URL:** on a Perxel domain (`<slug>-mcp.perxel.com`) in v1. The client's own domain is on the roadmap (Cloudflare for SaaS, both URLs served during a switch; users re-add the connector once).
- **Auth:** all tools, or only some. Each tool is public or private, and Claude shows a Connect card when a private tool is called.
- **Monitoring:** every tool call produces usage metrics (tool, status, latency, AI app, hashed caller; no personal data or tool arguments), viewable in a Perxel-provided Grafana dashboard at `dash.perxel.com/<slug>`, isolated per client.
- **Later:** a custom chatbot for the client's site, built on the same MCP (a separate product with LLM token costs).
- **Pricing:** yearly, like hosting, with a number of included authenticated users (see "Pricing model").
- The kit is public (source-available, no resale), so what Perxel sells is hosting, setup and maintenance, not the code.

## Goal

A public GitHub template for building a remote MCP server plus its monitoring dashboard, 100% on Cloudflare. Perxel sells MCP setup and hosting as a service (first target: Khatra, a WordPress site with a custom post type catalog); the kit is the SSOT every Perxel-built MCP follows.

## Decisions

- **Name:** Perxel MCP Kit, repo `perxel-mcp-kit`, public GitHub template.
- **License:** PolyForm Shield 1.0.0. Free to use and modify, not to resell or offer as a competing service. Say "source-available", not "open source" (OSI). Get a lawyer's look before selling on it.
- **Two repos:** `perxel-mcp-kit` (the product) and `perxel-mcp` (Perxel's own MCP, created from the template, the real test bed). One private repo per client MCP after that (`khatra-mcp`, ...).
- **Clones never edit `kit/`.** `pnpm kit:update` pulls the latest `kit/` from the remote kit repo (GitHub, a tag or branch), leaving the clone's own folders alone. Kit changes are committed and pushed in `perxel-mcp-kit`, then pulled into `perxel-mcp` with `kit:update`, the same flow clients use.
- **v1 supports Claude only** (claude.ai web, Desktop, mobile, Claude Code).
- **Everything runs in Perxel's Cloudflare account**, transferable to a client's account later (see `TRANSFER.md`).
- **MCP URLs:** one-level subdomains on perxel.com, covered by the free `*.perxel.com` certificate: `mcp.perxel.com`, `khatra-mcp.perxel.com`. Not `khatra.mcp.perxel.com` (needs the paid Advanced Certificate). The MCP users are client staff and a few power users, not the public, so a Perxel domain is fine. Client-domain URLs (`mcp.khatra.vn`) are a roadmap item.
- **Dashboard:** private, on `dash.perxel.com/<slug>`. Grafana OSS, not a self-built page.
- openrace-mcp and openwallet-mcp are untouched in v1; they get reviewed against `STANDARD.md` afterwards.

## Repo layout

### perxel-mcp-kit (public)

```
STANDARD.md          SSOT checklist: protocol, tools, auth, limits, metrics row contract, monitoring, tests, costs
README.md            start a new MCP from the template
TRANSFER.md          move a deployment to a client's Cloudflare account
LICENSE              PolyForm Shield 1.0.0
kit/                 owned by the kit; clones never edit
  core/              gate, OAuth + Access sign-in, consent page, rate limit, metrics, logs, health, docs page
  metrics-proxy/     Worker holding the only Analytics Engine token; scopes each key to one dataset
  dashboard/         Grafana container engine + base dashboard
  testing/           protocol test + eval helpers
  update/            the kit:update script
src/tools/           small generic example (one public, one private tool)
mcp.config.ts        example config
dashboards/          example extras (empty)
evals/               example questions
wrangler.mcp.jsonc, wrangler.dash.jsonc
```

### perxel-mcp (private, created from the template)

Only `src/tools/` (insights, works, services, products, plus a small private test tool like `whoami` to prove the sign-in flow), `mcp.config.ts`, `dashboards/`, `evals/`, the wrangler configs, and `kit/` from `kit:update`.

## Hosting (all in Perxel's Cloudflare account)

| Part | Service | URL |
|---|---|---|
| MCP | Worker + custom domain | `mcp.perxel.com`, `khatra-mcp.perxel.com` |
| OAuth tokens | KV | none |
| Static JSON last good copy (static JSON sources only) | KV | none |
| Sign-in | Cloudflare Access for SaaS (OIDC), email one-time code | `<team>.cloudflareaccess.com` |
| Metrics | Analytics Engine, one dataset per MCP | none |
| Metrics proxy | Worker: holds the only real token, each key reads one dataset | internal |
| Dashboard | Grafana OSS in a Cloudflare Container, one per client, Access-protected, Worker route per path | `dash.perxel.com/<slug>` |

Changing an MCP URL later (for example to a client domain): the Worker can serve both URLs during a transition (the OAuth library takes a list of resources). Each user removes the old connector, adds the new URL and signs in once, because OAuth tokens are tied to the URL. On Claude Team/Enterprise an org Owner re-adds it once for everyone. Metrics history is kept, since it's the same Worker and dataset.

## MCP features

- **Protocol:** `@modelcontextprotocol/server` v2 (2.2.0 at the time of writing), spec 2026-07-28, stateless (`createMcpHandler`), with the default fallback for 2025-era clients. Both existing repos are on v1 (`@modelcontextprotocol/sdk`).
- **Public and private tools on one server** (Claude calls this "lazy authentication"): each tool declares `access: "public" | "private"` plus a scope. A gate in front of the SDK:
  - public call: passes through
  - private call without a valid token: HTTP 401 with `WWW-Authenticate: Bearer resource_metadata=..., scope=...`, so Claude shows a Connect card and retries the call after sign-in. It must be a real 401; a 200 tool error does not start sign-in.
  - token without the needed scope: 403 `insufficient_scope` (step-up)
  - the gate reads the tool name from the `Mcp-Name` header (2026 spec), with a body parse as fallback for 2025-era clients
- **OAuth:** `@cloudflare/workers-oauth-provider` (1.2.1): CIMD and DCR both on (DCR kept for future ChatGPT/Gemini support), PKCE S256, refresh-token rotation, RFC 9207. Our own small Allow/Deny page uses the library's consent helpers (anti-forgery, no framing).
- **Sign-in:** Access for SaaS as an OIDC provider (Cloudflare's own `remote-mcp-cf-access` template pattern). Kept in one file so it can be swapped later.
- **Claude requirements to meet:**
  - redirect URIs `https://claude.ai/api/mcp/auth_callback` plus port-agnostic `http://localhost/callback` and `http://127.0.0.1/callback` (Claude Code)
  - `resource` exactly equals the MCP URL
  - token endpoint accepts form-urlencoded
  - discovery, registration and token endpoints answer in under 10 s, refresh in under 30 s
  - return `invalid_grant` for dead refresh tokens
- **Rate limits:** per user when signed in, per hashed IP otherwise, plus a shared bucket for Anthropic's cloud range `160.79.104.0/21` (claude.ai, Desktop, mobile and Cowork call from there).
- **Monitoring:** Workers Logs (structured, no personal data in arguments), one Analytics Engine row per tool call (columns fixed in `STANDARD.md`), `/health` with version and upstream status.
- **Docs page:** `GET /` shows connect instructions and the tool list, generated from the tool definitions.
- **Tests:**
  - unit tests per tool
  - protocol test (an in-process MCP client checks the tool list, schemas, a call, a validation error, 2025-client compatibility)
  - gate tests (200 / 401 / 403)
  - eval questions against `wrangler dev` or a deployed URL
  - MCP Inspector launched by `pnpm dev`
- **Dev rule:** never point a local client at a production URL.

## Data sources

The kit supports two kinds of data source. The tools look the same to the AI app either way; only the inside of each tool's `execute()` differs.

### 1. API (openrace, Khatra)

The API filters, sorts and paginates; the MCP forwards the call and trims the response. Use it for large data, frequently changing or per-user data, or data other consumers also need. Khatra: a WordPress plugin exposes the custom post type (for example `/wp-json/khatra/v1/products?q=...`), WordPress does the filtering, and the MCP calls it.

### 2. Static JSON (Perxel, small content sites)

The owner's site generates one JSON file at build time. The MCP Worker loads it and filters in memory. The AI app never sees the file, only each tool's result.

**Perxel specifics:**
- perxel-web-2026 writes `perxel.com/mcp/content.json` at build time, listed items only (no drafts or unlisted), including the MDX body as plain text. It ships through the existing GitHub Actions deploy.
- Build-time reading of MDX is fine; the site's "no filesystem at runtime on Workers" rule is still respected.
- Before choosing between a prebuild script and a statically generated route, read `lib/content/collections.ts`.
- Optional: read the file through a service binding to the site's Worker instead of a public URL. The content is public anyway.

**Size (measured 2026-09-30):** 26 MDX files, about 194 KB raw (about 50 KB gzipped): insights 10 files/81 KB, services 6/54 KB, works 4/21 KB, products 6/38 KB. Parsing takes 1–2 ms of CPU and only happens when a new instance starts; memory use is well under 1 MB of the 128 MB per instance. One file stays fine up to roughly a few MB. At tens of MB or thousands of items, split it into an index plus per-item files, or move to D1 or an API. Khatra's few hundred products would be around 1 MB, still fine as one file if it ever used this source.

**Updates:** a push to perxel-web redeploys the site and replaces the file. The MCP doesn't know about the push and isn't redeployed. It re-checks the file on a short interval (about 10 minutes, using a conditional request with the ETag), so new content appears within minutes. An instant "refresh now" call from the site's deploy workflow is optional and not needed for v1.

**Where the copy lives (the loading order):**
1. **Memory copy** (per Worker instance): the fast path for almost every call. It's temporary: a new instance starts empty.
2. If memory is empty or stale, **fetch the file.** On success, use it, store it in memory, and **write it to KV only if it changed.**
3. If the fetch fails, **read the last good copy from KV.** KV survives restarts, deploys and data centers.
4. If KV is empty too (only on the very first run ever), the tool returns a clear error.

KV costs: reads only when memory is empty (100k/day free, 10M/month on Paid), writes only when content changes, a value can be up to 25 MiB. The Cache API was rejected as the fallback because entries can be evicted at any time and are per data center.

`/health` shows where the current copy came from (`memory`, `fetch` or `kv-fallback`) and its date or version, so a stale fallback is visible.

The kit provides this as a shared helper: loader, cache, KV fallback, plus search that ignores Vietnamese diacritics (reusing openrace's `fold-text.ts` approach), filters and get-by-slug.

### Token rules (both source types, written into STANDARD.md)

Only what a tool returns reaches the AI and costs tokens.
- List and search tools return compact items only: title, slug, a short excerpt, URL and category. Never full text.
- Full text comes only from a detail tool, for one item (for example `get_insight(slug)`).
- Every list has a `limit` with a small default (for example 5, max 20).
- No "dump everything" tool. Even `list_all` returns titles and slugs only.
- Rough numbers: a typical question (one search, maybe one detail) is about 1–4k tokens. Returning the whole Perxel file would be about 50k+ tokens.

## Dashboard

- Grafana OSS in a Cloudflare Container, with no saved state: everything is provisioned from files (the data source, the base dashboard, the clone's own `dashboards/` extras). The container's disk is wiped when it sleeps, so edits made in the UI are lost: design in Grafana, export the JSON, commit, deploy.
- Anonymous read-only viewing, Explore disabled, Cloudflare Access rule per path, Grafana served from a sub-path.
- Data source: the ClickHouse plugin (Cloudflare's documented way to query Analytics Engine from Grafana), pointed at the **metrics proxy**, not at Cloudflare directly.
- **Why the proxy:** an Analytics Engine token (Account Analytics Read) is account-wide and can't be limited to one dataset. With all clients in one account, a token inside Khatra's Grafana could read openrace's metrics. The proxy keeps the only real token, gives each dashboard its own key, and rejects any query that reads another dataset. Khatra's dashboard can then never read another client's data, even through a bug or a leaked key.
- Onboarding a client: add a proxy key for the client's dataset, add a Worker route and an Access rule for `/<slug>`, deploy the clone's dashboard.

## Costs and limits (for pricing)

Checked 2026-09-30.

- **Workers Paid: $5/month.**
  - Includes 10M requests, then $0.30 per million, and 30M CPU-ms, then $0.02 per million.
  - Covers the MCPs, KV, the proxy and the containers at small-client scale.
  - Don't run clients on the free plan: its 10 ms CPU cap per request is a real risk.
- **Containers:** included in Workers Paid (375 vCPU-min, 25 GiB-h memory, 200 GB-h disk per month), billed only while running, sleeping when idle.
- **Zero Trust:** 50 free users **shared across all clients** (staff logins plus dashboard viewers), then about $7/user/month.
- **Analytics Engine:** 3-month retention, 250 data points per invocation.
- **Claude plans:** Free allows 1 custom connector.
- **LLM tokens are paid by the user's AI subscription**, not by the MCP. An on-site chatbot for a client would be a separate product with its own token cost.

## Pricing model (draft, no figures yet)

Charge yearly, like hosting. The structure follows the real cost drivers:

- **One-off setup fee.** Depends on how ready the client's data is:
  - tier A: a clean API or static JSON source already exists (a few days of work)
  - tier B: a sync, read API or WordPress connector setup is needed first
- **Yearly base fee.** Hosting (the Workers Paid plan, shared), maintenance, SDK and spec upgrades, monitoring, the Grafana dashboard, and small tool changes. Always charged, because an all-public MCP has zero authenticated users.
- **Authenticated users.** Include N users in the base fee and charge per extra user each year. The cost behind it: Cloudflare Zero Trust has 50 free seats **shared across all Perxel clients**, then about $7/user/month. **Dashboard viewers also use seats.** Keep a margin over $84/user/year once past 50 total.
- **Add-ons:**
  - private tools or OAuth setup
  - client-domain URL (Cloudflare for SaaS: 100 hostnames free, then $0.10 each per month)
  - extra dashboards (for example GA4)
  - new tools beyond the included changes
- **Separate product: custom chatbot.** Priced with its LLM token cost passed through at cost, or bundled with a usage cap.

Watch: Containers and Workers overages once clients grow; the shared 50-seat Zero Trust pool (the first real cost step).

## Build order

1. [x] Scaffold `perxel-mcp-kit`: `STANDARD.md`, `kit/core`, example tools, unit and protocol tests, evals.
2. [x] `kit:update` and the static JSON data source helper.
3. [x] OAuth: gate, Allow/Deny page, Access OIDC sign-in, gate tests.
4. [x] Metrics proxy, then `kit/dashboard` and the base dashboard.
5. [x] `TRANSFER.md`, README, LICENSE.
6. [ ] Not started, needs approval: the `content.json` export in perxel-web-2026, creating `perxel-mcp` from the template, and deploying `perxel-mcp` to `mcp.perxel.com` and `dash.perxel.com/perxel`. The user then tests the Claude Connect card and the Access login.

No deploys, pushes, or changes to openrace or openwallet without asking.

## To verify before selling on it

- Build and run the Grafana container (Docker wasn't available during the build): memory use and cold start decide the instance size (now `basic`), and all nine base panels must render through the proxy key.
- The ClickHouse plugin working through the metrics proxy, live.
- A real deploy: KV, Analytics Engine, Access sign-in and the Claude Connect card were never run against Cloudflare.
- The `kit:update` GitHub-download path (only the `--from` path is tested).
- Which Cloudflare account openrace runs in (it matters for `dash.perxel.com/openrace`).
- Whether openrace and openwallet need the standard metrics row before their dashboards work (they write different metrics shapes today).

## Build result (2026-09-30)

Built in `perxel/perxel-mcp-kit`, phases 1–5, no deploys, no other repo touched. `pnpm typecheck` clean, `pnpm test` 13 files / 115 tests passing, none deleted or weakened.

**What exists:** `STANDARD.md`; `kit/core` (stateless SDK v2 handler, tool pattern, gate, OAuth + Access OIDC sign-in, consent page, rate limit, metrics row, logs, `/health`, docs page); example tools `get_time` (public) and `whoami` (private); `kit:update`; static JSON source with diacritic-insensitive search; metrics proxy with a per-dataset SQL validator; Grafana container dashboard (`base.json`, nine panels); `README.md`, `TRANSFER.md`, `LICENSE` (PolyForm Shield 1.0.0, official text, Required Notice Perxel).

**Where the installed APIs differed from this plan:**
- `@modelcontextprotocol/server@2.2.0` has no `Client` class, so `protocol.test.ts` speaks raw JSON-RPC over `worker.fetch` (a client package would break the pinned-deps rule).
- `@cloudflare/workers-oauth-provider` imports `cloudflare:workers`, which plain-Node vitest can't load. `vitest.config.ts` aliases it to `kit/testing/cloudflare-workers-stub.ts` and sets the `global_fetch_strictly_public` flag in tests. Production is unaffected.
- The rate-limit binding type is `RateLimit`, not `RateLimiter`.
- Library behaviors found in `dist`, not in the types: PKCE S256-only and refresh rotation are defaults; `token_endpoint_auth_methods_supported` is always `[client_secret_basic, client_secret_post, none]`; the provider 404s the bare `/.well-known/oauth-protected-resource`, so the kit serves both metadata paths from one `resourceMetadataDoc`.
- Metrics doubles are `[latency, count, bytes]`.
- Grafana froze the `grafana-oss` repo after 12.4.0; 13.0.2 is its newest tag (switch image repos if it goes stale).

**Decisions made while building:**
- *Toolchain pins:* vitest 4.1.11 (latest 4.x, not 5.x); `@types/node` added (implied by `types: ["node"]`); `yaml@2.9.1` is the one allowed extra dependency (dashboard tests); `@cloudflare/containers@0.3.7`; `grafana/grafana-oss:13.0.2`; `vertamedia-clickhouse-datasource@3.4.11`.
- *Version and caller keys:* `kit/VERSION` is the SSOT, and `kit/core/version.ts` is generated from it by `kit:update` (esbuild can't bundle `?raw`). Caller keys are a single SHA-256 of `salt:userId` or `salt:ip:date`.
- *Tools and search:* `structuredContent` only for plain-object tool data. Search scores title 10 > excerpt/category/tags 4/3/3 > body 1; a blank query lists the first N. Unknown tool names never require auth.
- *Gate:* body parse wins over `Mcp-Name`/`Mcp-Method` headers. Gate 401 rows use code `""`, bad-token 401s use `invalid_token`, 403s use `insufficient_scope`, and 429 rows stay `anon`.
- *Static source:* `get()` awaits the KV backup write (no `waitUntil`). `/health` `from` is the last load path used (`fetch`, `memory`, `kv-fallback`, `empty`).
- *Evals:* prose between questions is ignored; prose inside a question is a parse error. Remote URLs need `--allow-remote`.
- *kit:update:* uses system `tar` and `git ls-remote`; a dirty `kit/` is refused.
- *Metrics proxy:* serves GET `?query=` and POST (raw or JSON `query`); Bearer preferred, basic-auth password as fallback; a missing or wrong key gets the same 401. The validator strips comments and strings, and rejects `;`+more, `INTO`/`ATTACH`, `system.`, dotted or mismatched datasets, and queries with no FROM. A comma-join bypass (`FROM mcp_a, mcp_b`) was found and fixed.
- *Dashboard:* the dataset is stamped at build time (`ARG DATASET` + `image_vars`) so clones never edit `kit/`; runtime config flows worker vars/secrets → container `envVars` → Grafana `$__env{...}`. The dashboard test derives its expected dataset from `wrangler.dash.jsonc`.
- *OAuth:* the approved consent subset is carried across the Access round-trip in `beginUpstream` data. The kit adapts Cloudflare's `remote-mcp-cf-access` template (no `McpAgent`/DO state; the library's handle-and-cookie replaces the hand-written CSRF).

**Human setup before first deploy** (full steps in `README.md`): Workers Paid plan; create `OAUTH_KV` and `CONTENT_KV`; Access for SaaS OIDC app with redirect `https://<host>/callback` and one-time PIN; secrets (`IP_HASH_SALT`, `COOKIE_ENCRYPTION_KEY`, `ACCESS_*`); unique rate-limit `namespace_id`s; custom domain and exact `MCP_PUBLIC_URL`; deploy the MCP Worker; proxy (`CF_ACCOUNT_ID`, `CF_API_TOKEN`, `PROXY_KEYS`); dashboard (`SLUG`, `PROXY_URL`, `DATASET`, `PROXY_KEY`, Worker route, Access rule); then test the Claude Connect card, the Access login and the dashboard panels.

## Roadmap (not in v1)

- **ChatGPT:**
  - developer mode, paid plans, web only
  - OAuth with CIMD, DCR or a static client; no API keys
  - mixed auth uses per-tool `securitySchemes` and a tool result carrying `_meta["mcp/www_authenticate"]`, not an HTTP 401
  - redirect URI `https://chatgpt.com/connector_platform_oauth_redirect`
  - write tools on Plus/Pro are unconfirmed
  - the gate can branch on client identity (sent on every 2026-spec request); needs a live test
- **Gemini Enterprise (Business):** the admin enters an OAuth client ID and secret (no DCR), redirect URI `https://vertexaisearch.cloud.google.com/oauth-redirect`. Needs a pre-registered client script.
- **Gemini consumer app:** personal accounts only, 18+, US only, English only. Not usable for Vietnam-based staff today.
- **Client-domain MCP URLs** (`mcp.khatra.vn`) via Cloudflare for SaaS: 100 custom hostnames free, then $0.10 each per month. Test several Workers on custom hostnames, with a router Worker as the fallback. Serve both URLs during the switch.
- **Generic Perxel WordPress connector plugin** (for example "Perxel MCP Connector"):
  - exposes any custom post type (chosen fields, filters, search, pagination) as a clean read API for a Perxel MCP
  - shared-secret auth between the MCP and the plugin, unless the content is public anyway
  - the data side only, not a login
  - Khatra is the first user
  - a product of its own for WordPress clients
- **Custom chatbot on the client's site**, built on the same MCP:
  - the site calls an LLM API (for example Claude) with the MCP's tools
  - it adds per-question token costs, so it's priced separately
  - it needs its own abuse protection (rate limits, a token budget per day)
- A GA4 dashboard for Perxel, once a maintained Grafana plugin is found (otherwise Looker Studio).
- Migrate openrace and openwallet to the standard.
- Move `kit/core` to an npm package if clones multiply.
- Static-header auth once Claude's beta is broadly available (limited to some organizations now, with open bug reports).
- Alerting (for example Cloudflare health-check alerts, which need a paid zone plan).

## Findings from the planning session (2026-09-30)

Everything learned while planning, so the build doesn't have to rediscover it.

### A. MCP basics as they apply to us

- An MCP server gives an AI app a menu of **tools** (name, description, input schema). The model picks a tool, sends arguments and gets JSON back. MCP also has **resources** and **prompts**; we only use tools.
- A remote server speaks JSON-RPC over HTTP POST ("Streamable HTTP"). Under the 2025 spec a conversation was `initialize` → `tools/list` → `tools/call`, one HTTP request each. The 2026-07-28 spec removes the handshake.
- **Who pays what:** the user's AI subscription pays for the LLM tokens. The MCP only answers HTTP requests. Our real costs are hosting (near zero), the upstream API and database, and engineering time. The exception is an on-site chatbot, where the client or Perxel calls the LLM API and pays per question.
- Rough traffic sizing: one user question is about 3–8 HTTP requests (a handshake on 2025 clients, the tool list, 1–4 calls). A proxy Worker uses a few ms of CPU per request, and time spent waiting on `fetch` doesn't count. So 5,000 questions a month is about 40k requests, and 1M questions a month is about 6M requests, still inside the $5 plan.
- Limits that actually bite:
  - **Tool count:** every description is sent on every turn. Past about 15–20 tools, selection gets worse; aim for 5–10.
  - **Response size:** Claude Code warns at about 10k tokens (default maximum about 25k). Use a compact list tool plus a detail tool.
  - **Cached tool lists:** after a tool rename, users may need to reconnect.
  - **Anthropic's cloud IPs:** claude.ai calls from a few IPs on behalf of many users, so a per-IP rate limit alone is wrong.
- Provider responsibilities:
  - read-only by default (write tools carry a different risk and liability, so price them separately)
  - upstream admin keys never go in the MCP Worker (a narrow shared secret only, the openrace pattern)
  - prompt injection through data (product descriptions and reviews go straight into the model's context)
  - data honesty: unknown is `null`, not 0; state units (VND) and freshness
  - monitoring, and eval questions as the proof of value

### B. The existing MCP servers (read 2026-09-30)

**openrace-mcp** (`~/PHUC-LOCAL/openrace/openrace-mcp`), in active use:
- Cloudflare Worker `openrace-mcp.bmp.workers.dev`, MCP at `/mcp`, `GET /` docs page, `/health`, `GET /mcp` returns 405. Stateless (`WebStandardStreamableHTTPServerTransport`, `sessionIdGenerator: undefined`, a new server per request). SDK v1 `@modelcontextprotocol/sdk ^1.12.0`, zod 3.
- Reaches openrace-api through a **service binding** (`API` → `openrace-api`) and sends `X-MCP-Secret`, so the API skips its own rate limit and tags the request `mcp-upstream`.
- No auth (public, read-only).
- Rate limit binding: 60/min per hashed IP (`RATE_LIMITER`, namespace 2001), plus 600/min shared for Anthropic's CIDR `160.79.104.0/21` (`RATE_LIMITER_ANTHROPIC`, namespace 2002), matched on `CF-Connecting-IP`.
- The IP hash is salted with `IP_HASH_SALT` plus the Vietnam date, so the key rotates daily; it matches openrace-api's hash.
- Metrics: Analytics Engine dataset `openrace_api_requests` (**shared with openrace-api**), one row per `tools/call`:
  - index = caller key
  - blobs = `mcp`, tool, status, client family, "", country, `tools/call`, argument summary
  - doubles = latency, result count
- `arg-summary.ts` is copied byte-for-byte from openrace-api (a contract between the two).
- Tools: search_races, get_race, list_places, find_series, find_organizers, get_organizer, get_data_completeness, get_series. Each tool file exports an `*_INFO` constant used by the docs page, so the docs can't go stale. There's a `scripts/eval.ts` with the roadmap's questions.
- `AGENTS.md` ties work to openrace-data's roadmap and says **free tiers only**.
- Inspector hosted at `openrace-inspector.pages.dev`.

**openwallet-mcp** (`~/PHUC-LOCAL/openwallet/openwallet-mcp`), not maintained:
- Worker at `mcp.openwallet.vn`, version 0.3.1, SDK v1, stateless. It handles `/` as the MCP path (not `/mcp`), allows `/sse`, `/message` and `/badge`, and `GET /` returns 405.
- Auth: the secret `MCP_KEYS` holds a JSON array `{key, expires, label}`, read from `X-MCP-Key` or `Authorization: Bearer`.
  - The key is checked with a plain string compare.
  - There's no rate limit and no per-key usage cap, so a leaked key works without limit until it expires.
  - Localhost skips auth.
  - An earlier Origin-header bypass for the inspector (commit `fe71d15`) no longer appears in `src/index.ts`. An Origin check would have been spoofable anyway.
- Calls `api.openwallet.vn` over public HTTPS with `OPENWALLET_API_KEY`.
- Metrics: Analytics Engine dataset `mcp_usage` (blobs label and path, index label), plus Langfuse traces (a third-party SaaS with its own free-tier limits). Observability logs and traces use `head_sampling_rate = 1` with `persist = true`, so every request is logged; Workers Logs has its own quota.
- Lessons in `.claude/debug-notes.md`:
  - `McpAgent` with Durable Objects and SQLite blew the **free-tier DO SQLite write quota**. A local client pointed at production reconnected in a loop, creating DOs and writes. The fix was the stateless Worker (commit `a134e57`). Removing a DO class needs a `[[migrations]]` `deleted_classes` entry (deploy error 10064).
  - pnpm v11 moved build-script approval to `pnpm-workspace.yaml` as `allowBuilds` (esbuild, sharp, workerd), and `packages: []` is required for CF Pages.
  - Pin the pnpm major version in CI.
  - Rule: never point a local client at the production URL.
- Its static-key auth probably doesn't work in claude.ai web/mobile: header auth is beta and only for some organizations.

**The two are inconsistent:** different paths (`/mcp` vs `/`), auth (none vs static keys), metrics shapes and datasets, rate limiting (yes vs no), and test runners (tsx `node:test` vs vitest). The kit's `STANDARD.md` fixes this.

### C. Claude connector facts (official docs)

- Custom connectors by URL work on Free, Pro, Max, Team and Enterprise. **Free: one custom connector.** On Team/Enterprise an Owner adds it for the org and members click Connect.
- Auth types:
  - `oauth_dcr` (default)
  - `oauth_cimd` (default; chosen only when the authorization server metadata has `client_id_metadata_document_supported: true` **and** `"none"` in `token_endpoint_auth_methods_supported`, otherwise falls back to DCR)
  - `oauth_anthropic_creds` and `custom_connection` (by email to mcp-review@anthropic.com)
  - `static_headers` (beta, limited orgs)
  - `none`
- Dialog options: "Sign in now", "Sign in when needed" (lazy auth) and "No sign-in". OAuth client: "Use Claude's published identity" (CIMD, recommended), "Register automatically" (DCR), or "Use your own OAuth client".
- Request headers:
  - up to 4 headers
  - standard names (`authorization`, `x-api-key`, `x-auth-token`) allowed; custom names need Anthropic's approval
  - sent exactly as entered (include `Bearer `)
  - can be combined with OAuth, except the `Authorization` header
  - **auth settings can't be edited after adding**: remove and re-add
- Bug reports: issue #967 (2026-08-28) says neither the headers nor the token get sent in some cases; related issues #690, #644, #110, #112.
- Requirements for the server:
  - a **401** starts sign-in (a `WWW-Authenticate` header on a 200 is ignored)
  - Claude uses only the **first** entry of `authorization_servers`
  - `resource` must equal the URL exactly as the user entered it
  - the `resource_metadata` pointer in the 401 is the reliable path; otherwise Claude probes `/.well-known/oauth-protected-resource/<path>` and then `/.well-known/oauth-protected-resource`
  - PKCE S256 required, and advertise `code_challenge_methods_supported: ["S256"]`
  - `scope` in the 401 controls which scopes Claude requests; otherwise it uses `scopes_supported`, plus `offline_access` if listed
  - token endpoint: form-urlencoded; DCR `/register` is JSON
  - refresh: reactive on 401 and proactive up to 5 minutes before expiry; return `invalid_grant`; rotate refresh tokens for public clients
  - timeouts: 10 s for discovery, registration and token endpoints, 30 s for refresh
  - redirect URIs: `https://claude.ai/api/mcp/auth_callback`; Claude Code uses a loopback on any port (`http://localhost/callback` and `http://127.0.0.1/callback`, port ignored)
  - no `client_credentials` grant
  - discovery metadata is cached globally for about 5 minutes per URL
  - traffic comes from `160.79.104.0/21`
  - the consent page must show the redirect hostname and warn on localhost
- Lazy authentication: public tools work before sign-in. On a private tool, the server returns 401 **before the SDK runs**. Claude shows an inline Connect card, the user signs in in a popup, and Claude retries the same call. A `200` with `isError: true` shows "please sign in" text and no card. A `403` step-up works only with `error="insufficient_scope"` and should list every scope still needed.
- Desktop extensions (MCPB) are the local alternative; not relevant to us.

### D. The MCP spec and SDK (verified by installing and reading the types)

- The 2026-07-28 spec:
  - removes `initialize`/`initialized` and `Mcp-Session-Id`; each request carries its protocol version, client identity and capabilities
  - HTTP+SSE deprecated (one-year offramp)
  - `Mcp-Method` and `Mcp-Name` headers for routing
  - list results carry `ttlMs` and `cacheScope`
  - Multi Round-Trip Requests (`resultType: "input_required"`)
  - Tasks moved to an extension
  - DCR deprecated in favor of CIMD
  - RFC 9207 issuer validation required
  - roots, sampling and logging deprecated
- Package versions on 2026-09-30:
  - `@modelcontextprotocol/server` 2.2.0 (v2, replaces `@modelcontextprotocol/sdk`, whose latest is 1.31.0)
  - `@modelcontextprotocol/inspector` 2.8.0
  - `@cloudflare/workers-oauth-provider` 1.2.1
  - `agents` 0.24.0 (not needed)
  - wrangler 4.144.0
  - zod 4.6.5 (the SDK v2 needs zod ^4.2)
- SDK v2 API:
  - Serving and handler:
    - `createMcpHandler(factory, options)` returns `{ fetch, close, notify, bus }`; `export default handler` is enough on Workers
    - `handler.fetch(request, { authInfo })` passes the verified identity to tools as `ctx.http.authInfo`
    - the factory receives `{ era: 'legacy' | 'modern', authInfo, requestInfo }`
  - Options:
    - `legacy: 'stateless'` (default: serves 2025 clients statelessly; GET/DELETE get 405) or `'reject'`
    - `responseMode: 'auto' | 'sse' | 'json'`
    - `maxRequestBodySize` (default 4 MiB, 413 above it)
    - `keepAliveMs`, `maxSubscriptions`
  - Tools and caching:
    - `new McpServer({name, version}, { cacheHints: { 'tools/list': { ttlMs, cacheScope: 'public' } } })`
    - `registerTool(name, { title, description, inputSchema: z.object(...), outputSchema, annotations: { readOnlyHint }, scopeChallenge }, handler)`
    - a failed schema check returns `isError: true` without running the handler
  - Other helpers: `isLegacyRequest(request)`, `hostHeaderValidationResponse`, `originValidationResponse`, `requireBearerAuth`, `verifyBearerToken`, `bearerAuthChallengeResponse`, `buildOAuthProtectedResourceMetadata`, `requireScopes`, a `./validators/cf-worker` validator, and Node/Express/Hono adapters.
  - TypeScript 6 or later needs `"types": ["node"]` in tsconfig.
- workers-oauth-provider:
  - Setup: needs the **`OAUTH_KV`** binding, and the `global_fetch_strictly_public` compatibility flag if CIMD is accepted.
  - Topologies:
    - split shape: an `OAuthAuthorizationServer` Worker plus an `OAuthResourceServer` over a service binding (`validateToken` RPC)
    - one-Worker shape: `OAuthProvider` with `apiRoute`, `apiHandler` and `defaultHandler`. It protects the **whole** `apiRoute`, so lazy auth needs a hand-wired gate: validate a token when one is present, pass public calls through, answer 401 otherwise.
  - Consent and upstream sign-in helpers:
    - `parseAuthRequest`, `describeConsent`, `beginConsent`, `approveConsent`, `denyConsent`, `isConsentRemembered` (remembered consent in a `__Host-` cookie, 30 days)
    - `beginUpstream` / `finishUpstream` for signing in through another provider
    - `completeAuthorization({ request, userId, scope, props })`, which by default revokes the user's earlier grants for the same client and resource
    - `insufficientScope` for 403s
    - `tokenExchangeCallback` for refreshing the upstream token
    - `AuthorizationError` / `CimdFetchError` handling rules
  - Storage: tokens, codes and secrets are stored only as hashes; `props` are encrypted with a key only the token holder can unwrap.

### E. Other AI apps (for the roadmap)

- **ChatGPT:**
  - developer mode on Pro, Plus, Business, Enterprise and Edu, **web only**
  - SSE and streaming HTTP
  - auth: OAuth, none, or mixed; no API keys or headers
  - OAuth client identity: CIMD, DCR, a static client, or mTLS
  - mixed auth: per-tool `securitySchemes: [{ type: "noauth" } | { type: "oauth2", scopes }]`, and the login is triggered by a **tool result** with `_meta["mcp/www_authenticate"]` (its HTTP 401 behavior isn't documented)
  - ChatGPT sends `resource=` on the authorize and token requests, and `aud` must match it
  - redirect `https://chatgpt.com/connector_platform_oauth_redirect` (RFC 9207 servers), otherwise `https://chatgpt.com/connector/oauth/{callback_id}`
  - write actions ask for confirmation by default
  - third-party guides say Plus/Pro are read-only; unconfirmed
- **Gemini app (consumer):** Settings → Connected Apps → Add a custom app. Personal Google account, 18+, **US only**, English only, Keep Activity on, set up on web. Supports DCR or credentials entered manually. Write actions need confirmation.
- **Gemini Enterprise (Business edition):** a team admin adds it. No auth, or OAuth with a manually entered client ID and secret (no DCR). Redirect `https://vertexaisearch.cloud.google.com/oauth-redirect`. StreamableHTTP only.

### F. Cloudflare facts

- Workers:
  - Free: 100k requests/day, 10 ms CPU per request.
  - Paid: $5/month with 10M requests (then $0.30 per million) and 30M CPU-ms (then $0.02 per million); up to 5 minutes of CPU per request (default 30 s).
- KV: 100k reads/day free, 10M/month on Paid, 1 GB included.
- D1: 5M row reads/day free, 25B/month on Paid (then $0.001 per million).
- Durable Objects: 13,000 GB-s/day free, 400,000 GB-s/month on Paid (then $12.50 per million).
- Vectorize: Paid only, 50M queried dimensions/month (then $0.01 per million). Not needed for a catalog of a few hundred products.
- Containers:
  - GA 2026-04-13, requires Workers Paid.
  - Included: 375 vCPU-min, 25 GiB-h memory, 200 GB-h disk per month. Overage: $0.000020 per vCPU-s, $0.0000025 per GiB-s, $0.00000007 per GB-s.
  - Six instance types, from 1/16 vCPU with 256 MiB up to 4 vCPU with 12 GiB. Billed per 10 ms while running; sleeps after `sleepAfter`, when **the filesystem is wiped** (disk snapshots are still rolling out). Egress $0.025–0.05/GB after the included amount.
- Analytics Engine:
  - 3-month retention
  - 250 data points per invocation, up to 20 blobs, 20 doubles and 1 index per point, 16 KB of blobs, 96-byte index
  - SQL API needs an **Account Analytics Read** token, which is account-wide with no per-dataset scoping
  - Grafana: the Altinity ClickHouse plugin, URL `https://api.cloudflare.com/client/v4/accounts/<id>/analytics_engine/sql`, header `Authorization: Bearer <token>`, `$timeSeries`/`$timeFilter` macros
- Rate Limiting binding: `[[ratelimits]]` with `simple = { limit, period }` (used by openrace).
- Cloudflare for SaaS:
  - custom hostnames: the customer adds a CNAME to your zone, and Cloudflare issues the certificate
  - Free, Pro and Business include **100 hostnames**, then **$0.10** each per month
  - Worker as origin: an originless DNS record (for example `AAAA 100::`) plus routes `*/*` or `vanity.customer.com/*`
  - several Workers on different custom hostnames isn't documented, with a router Worker as the fallback
  - Access on custom hostnames isn't documented either, which is why sign-in uses Access as an OIDC provider instead
- Certificates: the free Universal SSL covers `perxel.com` and `*.perxel.com` only. A second subdomain level (`x.mcp.perxel.com`) needs the Advanced Certificate (about $10/month). A Worker custom domain must be a zone in the same account; Worker routes can be path-based on one hostname.
- Zero Trust:
  - Free up to 50 users (24 h log retention), then about $7/user/month.
  - Access for SaaS (OIDC) is on the free plan.
  - Cloudflare's template `cloudflare/ai/demos/remote-mcp-cf-access` uses Access for SaaS as the OIDC login with a `/callback` redirect, and needs the secrets `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET`, `ACCESS_TOKEN_URL`, `ACCESS_AUTHORIZATION_URL`, `ACCESS_JWKS_URL` and `COOKIE_ENCRYPTION_KEY`. Login is by one-time PIN or another identity provider.
  - **Managed OAuth** (Access as the whole OAuth server; the MCP validates `Cf-Access-Jwt-Assertion`) protects the whole app, so it can't mix public and private tools.
  - **MCP Server Portals** (GA 2026-09-24) bundle several MCP servers behind one Access login, with service tokens and private-network servers. A possible later upsell for bigger clients.
- There's no "move a Worker to another account": a transfer is a redeploy plus secrets. OAuth tokens in KV and the metrics history stay behind.

### G. Grafana facts

- Open-source dashboard tool (AGPLv3). It reads from data sources and draws charts, and stores no copy of the data. Running it unmodified for clients doesn't trigger AGPL source publishing.
- Grafana Cloud free: 3 users, 10k metrics series, 50 GB logs, traces and profiles, 14-day retention (for its own storage), a limit of 1,000 dashboards and folders.
- Externally shared dashboards: a public link (read-only, until paused), or specific people by email (private preview, will cost money later; links valid 1 h, access 30 days). No template variables, time range off by default, library panels unsupported. The ClickHouse plugin isn't on the confirmed list.
- Self-hosting options that were considered:
  - a VPS with Docker at about $4–6/month (server upkeep)
  - Cloudflare Containers with no saved state (chosen)
  - Grafana Cloud (the fallback)
- GA4 has community Grafana plugins; no maintained one has been verified yet.

### H. Business notes for selling the service (Khatra and others)

- Khatra: WordPress with a custom post type (not WooCommerce) and hundreds of products. MCP users are staff first, then a few power users, all through AI apps. The data side is a WordPress plugin exposing the custom post type as a clean read API. A few hundred products fit in D1 or even in memory, with no vector search needed. Reuse openrace's `fold-text.ts` for search without Vietnamese diacritics.
- Honest value pitch, strongest first:
  1. internal operations for staff
  2. powering an on-site chatbot (a separate product with a token cost)
  3. being ready for AI shopping assistants (early, not guaranteed traffic)
  
  A public MCP for shoppers is a weak sell today.
- The cost driver is how ready the client's data is, not the MCP itself. A clean API means a few days of work; no API means building a sync or read API first.
- Pricing structure:
  - setup tier A (clean API)
  - setup tier B (data sync or API needed)
  - add-on: OAuth and private tools
  - monthly retainer (hosting on the $5 plan, monitoring, API changes, new tools, usage report)
  - a separate on-site chatbot product
  - pricing input: Access seats beyond 50 across all clients cost about $7/user/month
- Perxel's own MCP needs a read source for the MDX collections, which live in the perxel-web-2026 repo. Workers have no runtime filesystem, so the likely approach is a JSON export at build time. Tools: search_content, get_work, get_service, list_products, get_insight, contact_info. Also a live demo for sales.

### I. Quick Vietnam market scan (2026-09-30; a quick scan, not deep research)

- **No productized, managed MCP service found in Vietnam.** Vietnamese content about MCP is mostly explainers: vinahost, tnd.vn, brandsvietnam, Finhay (which says it uses MCP for its own financial data), and lists of MCP servers.
- **Saigon Technology** (a large outsourcing company) sells "MCP Server Development": fully custom builds over ERP/CRM/databases, OAuth 2.1, hosting on Docker/K8s/Cloudflare Workers/on-prem, monitoring. Published rate **$26–46/hour**, as dedicated teams, staff augmentation or fixed-price builds. Targets enterprises, fintech and healthcare. No packaged or managed offering was found. That's the enterprise, per-hour end of the market; Perxel's niche is a small-business package with yearly hosting.
- **Community MCP servers for Vietnamese platforms** exist, for example KiotViet MCP (36 tools, by haudnn, and another by vansyson1308). They're self-hosted developer tools. None was found for Haravan or Sapo.
- **WordPress:**
  - The **official WordPress MCP Adapter** (`WordPress/mcp-adapter`, v0.6.1 of 2026-08-13, WordPress 6.9+) turns Abilities API abilities into MCP tools. HTTP transport at `/wp-json/mcp/` with application passwords (Basic auth); session-based (`Mcp-Session-Id`, 2025-style).
  - Aimed at plugin authors and developers; claude.ai remote-connector (OAuth) support isn't documented.
  - Weak default permission: any logged-in user, including Subscribers, unless set otherwise.
  - Automattic's earlier wordpress-mcp was archived on 2026-01-19. Official WooCommerce MCP is rolling out through 2026, and a community WooCommerce MCP exists.
  - **What this means for the Perxel WordPress connector:** don't compete with the official adapter as a generic MCP-in-WordPress. Position it as the data side of a **managed** MCP: curated read tools, hosted on Cloudflare (no load on the client's WordPress hosting), Claude OAuth with public/private tools, rate limits, and a dashboard. Consider building the connector on top of the Abilities API so it stays aligned with where WordPress core is going.
- **Adjacent market, Vietnamese chatbot SaaS** (the competition for the future chatbot product): BizChatAI about 300–500k VND/month, Ahachat 300–400k (enterprise 2M/month), Fchat 199–999k, aichatbot.com.vn 550k–1.1M/month, plus global tools (Botpress, Intercom, ManyChat, Chatfuel, Zalo AI, Yellow.ai; free to $199/month). These are mostly customer-service and Messenger/Zalo bots, cheap and priced monthly, which sets price expectations for any Perxel chatbot.
- Sources: https://saigontechnology.com/services/mcp-server-development/, https://www.pulsemcp.com/servers/haudnn-kiotviet, https://instawp.com/wordpress-mcp-adapter-review/, https://packagist.org/packages/wordpress/mcp-adapter, https://bizfly.vn/giai-phap/chat-bot-ai.html, https://www.tnd.vn/mcp-la-gi-chuan-cam-cong-cu-cho-ai-agent-18139/

## Sources (checked 2026-09-30)

- Claude custom connectors: https://claude.com/docs/connectors/custom/remote-mcp
- Claude connector authentication: https://claude.com/docs/connectors/building/authentication
- Claude lazy authentication: https://claude.com/docs/connectors/building/lazy-authentication
- Claude header-auth bug: https://github.com/anthropics/claude-ai-mcp/issues/967
- MCP 2026-07-28 spec: https://blog.modelcontextprotocol.io/posts/2026-07-28/
- MCP TypeScript SDK v2, HTTP serving: https://ts.sdk.modelcontextprotocol.io/v2/serving/http
- workers-oauth-provider: https://github.com/cloudflare/workers-oauth-provider
- Cloudflare Access for MCP servers: https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/saas-mcp/
- Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Containers pricing: https://developers.cloudflare.com/containers/pricing/
- Analytics Engine SQL API: https://developers.cloudflare.com/analytics/analytics-engine/sql-api/
- Analytics Engine limits: https://developers.cloudflare.com/analytics/analytics-engine/limits/
- Analytics Engine from Grafana: https://developers.cloudflare.com/analytics/analytics-engine/grafana/
- Cloudflare for SaaS plans: https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/
- Worker as SaaS origin: https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/
- Zero Trust plans: https://www.cloudflare.com/plans/zero-trust-services/
- OpenAI MCP auth: https://developers.openai.com/plugins/build/auth
- ChatGPT developer mode: https://developers.openai.com/api/docs/guides/developer-mode
- Gemini custom apps: https://support.google.com/gemini/answer/17209137
- Gemini Enterprise custom MCP: https://support.google.com/g/answer/17106276
