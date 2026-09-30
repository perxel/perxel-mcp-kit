# Plan 001, task list for the implementing agent (opencode)

Read `001-mcp-kit-v1.md` first; it holds the why and every researched fact. This file is the how: concrete decisions the plan left open, the task order and exact acceptance checks. Where the two files disagree, this file wins.

**Scope of this run:** build the kit in this repo (`perxel/perxel-mcp-kit`, remote `origin`) end to end, unattended. Nothing is deployed, nothing new is created (no `perxel-mcp` repo or folder, no GitHub repos, no Cloudflare resources), and no other repo is edited. The plan's build-order items that touch `perxel-web-2026` or `perxel-mcp`, and step 6 (deploy), are **out of scope** for this run.

## 0. Rules (read before any task)

1. **Never:** `wrangler deploy`, `wrangler login`, `wrangler secret put`, `wrangler kv namespace create` or any other command that changes a Cloudflare account; DNS or dashboard changes; creating repos, folders or files outside this repo (temp files under the OS temp dir are fine and must be cleaned up); editing any other repo. Reading `~/PHUC-LOCAL/openrace/openrace-mcp` is fine.
2. Git: commit after every task (`git add -A && git commit -m "<task id>: <summary>"`), and `git push origin main` at the end of every phase. Don't commit `.idea/`, `.dev.vars`, `node_modules/`, `.wrangler/` (add them to `.gitignore` in task 1.1). Never force-push, never rewrite history.
3. Use the exact versions in section 2. Don't upgrade, downgrade or swap a library.
4. **The installed types win over the plan.** The SDK v2 and workers-oauth-provider APIs in the plan (section D) came from reading types. Before using an API, open its `.d.ts` in `node_modules`. If a name differs, use the real one and write a line in `.claude/plans/001-notes.md` (`- <date> task X: plan said A, real API is B`).
5. Every task ends with `pnpm typecheck && pnpm test` passing. Don't mark a task done with a failing or skipped test. Don't delete or weaken a test to make it pass.
6. Keep code small and plain: no classes unless a library requires them, no dependencies beyond section 2. Comments explain *why*, like the openrace code does.
7. After each task, tick its box in section 5 and commit that with the task.
8. **Don't stop to ask.** When something is unclear, pick the simplest option that fits the plan and this file, record it in `.claude/plans/001-notes.md` (`- task X: unclear A, chose B because C`), and carry on. Only a true blocker ends the run early: a pinned version won't install, or a feature the design depends on doesn't exist in the installed library and there's no reasonable workaround. Then commit what works, push, write the blocker at the top of `001-notes.md`, and end with a report.
9. At the end of the run, write a final report at the top of `001-notes.md`: what was built, the final `pnpm test` summary, every "chose B" decision, what couldn't be verified (Docker isn't installed on this machine, and nothing ran against real Cloudflare), and the human setup steps from task 5.1's README.

## 1. Reference code to copy from (read-only)

`~/PHUC-LOCAL/openrace/openrace-mcp/src/lib/`:
- `fold-text.ts` → copy as-is into `kit/core/fold-text.ts`
- `anthropic-range.ts` (CIDR check) → copy into `kit/core/anthropic-range.ts`
- `rate-limit.ts`, `usage.ts` (callerKey: salted IP hash with the Vietnam date) → adapt into `kit/core/rate-limit.ts` and `kit/core/caller.ts`
- `docs-page.ts`, `metrics.ts` → pattern only; the kit versions are generated from tool definitions and use the new metrics row (section 3.6)
- `package.json` `dev` script → the Inspector-plus-wrangler pattern for `pnpm dev`

Cloudflare's Access sign-in template: `https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-cf-access` (fetch `src/access-handler.ts` and `src/workers-oauth-utils.ts` with `curl` from `raw.githubusercontent.com`). Adapt, don't copy blindly: it uses `McpAgent`/Durable Objects, which we don't.

## 2. Pinned toolchain

- Node 22 (installed: 22.23.1), pnpm `10.22.0` (`"packageManager": "pnpm@10.22.0"` in package.json). Build-script approval in `pnpm-workspace.yaml`: `onlyBuiltDependencies: [esbuild, workerd, sharp]`. Single package, no workspaces.
- dependencies: `@modelcontextprotocol/server@2.2.0`, `@cloudflare/workers-oauth-provider@1.2.1`, `zod@4.6.5`
- devDependencies: `wrangler@4.144.0`, `typescript@^6` (whatever `pnpm add -D typescript@6` resolves; pin it exactly), `@cloudflare/workers-types` (latest, pinned exactly), `vitest` (latest 3.x or 4.x, pinned), `tsx` (pinned), `@modelcontextprotocol/inspector@2.8.0`
- Dashboard only (task 4.x): `@cloudflare/containers` (latest, pinned), Docker image `grafana/grafana-oss` pinned to an exact version tag (not `latest`), plugin `vertamedia-clickhouse-datasource` (Altinity) pinned version.
- tsconfig: `strict: true`, `module: "ESNext"`, `moduleResolution: "Bundler"`, `target: "ES2022"`, `types: ["@cloudflare/workers-types", "node"]`, `noEmit: true`.
- Test runner: **vitest** (plain Node environment). Tests call the Worker's `fetch` directly with `new Request(...)` and a fake `env` (in-memory KV map, fake rate limiter, fake Analytics Engine that records `writeDataPoint` calls). No `vitest-pool-workers`.
- `compatibility_date = "2026-09-01"`, `compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]`.

Scripts in package.json: `dev` (Inspector + `wrangler dev -c wrangler.mcp.jsonc`, port 8788, Inspector UI 8002), `typecheck` (`tsc`), `test` (`vitest run`), `eval` (`tsx kit/testing/eval.ts`), `kit:update` (`tsx kit/update/update.ts`), `cf-typegen`.

## 3. Decisions the plan left open (now fixed)

### 3.1 URLs and routes (MCP Worker)

| Route | Behaviour |
|---|---|
| `POST /mcp` | MCP endpoint (gate → SDK handler). `GET`/`DELETE /mcp` → 405 (SDK default). |
| `GET /` | Docs page (HTML), generated from tool definitions + config |
| `GET /health` | JSON, section 3.7 |
| `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` | protected resource metadata; `resource` = `config.publicUrl + "/mcp"` exactly |
| `/.well-known/oauth-authorization-server`, `/authorize`, `/token`, `/register` | served by workers-oauth-provider |
| `/callback` | Access OIDC return |
| anything else | 404 JSON |

The MCP URL users paste is `https://<host>/mcp`.

### 3.2 Bindings, vars, secrets (MCP Worker)

| Name | Kind | Notes |
|---|---|---|
| `OAUTH_KV` | KV | required by workers-oauth-provider |
| `CONTENT_KV` | KV | static JSON last good copy (only if a static source is used) |
| `METRICS` | Analytics Engine | dataset `mcp_<slug>` (slug with `-` → `_`) |
| `RATE_LIMITER` | ratelimit | 60/min per caller |
| `RATE_LIMITER_ANTHROPIC` | ratelimit | 600/min shared for `160.79.104.0/21` |
| `MCP_PUBLIC_URL` | var | e.g. `https://mcp.perxel.com`; `http://localhost:8788` in `.dev.vars` |
| `CONTENT_URL` | var | static source URL, if used |
| `IP_HASH_SALT`, `COOKIE_ENCRYPTION_KEY`, `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET`, `ACCESS_TOKEN_URL`, `ACCESS_AUTHORIZATION_URL`, `ACCESS_JWKS_URL` | secrets | put a `.dev.vars.example` with placeholder values; never real ones |

Rate limiter `namespace_id`s must be unique per Cloudflare account: the template uses `"1001"`/`"1002"` with a comment `# change per MCP: unique in the account`. Write the KV ids as `"<run: wrangler kv namespace create OAUTH_KV>"` placeholders; the user fills them.

### 3.3 Tool definition (`kit/core/tool.ts`)

```ts
export type Access = "public" | "private";

export interface ToolContext {
  env: Env;                      // the clone's Env (generic)
  auth: { userId: string; email?: string; scopes: string[] } | null; // null for anonymous
  requestId: string;
  log: (event: string, fields?: Record<string, unknown>) => void;    // structured, no PII, no args
}

export interface ToolResult {
  data: unknown;                 // becomes structuredContent + JSON text content
  count?: number;                // items returned, for metrics doubles[2]; omit when not a list
}

export interface ToolDef<I extends z.ZodObject = z.ZodObject> {
  name: string;                  // snake_case, unique
  title: string;
  description: string;           // what it returns, units, freshness, limits
  access: Access;
  scope?: string;                // required when access === "private"; checked by the gate
  inputSchema: I;
  outputSchema?: z.ZodType;
  annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean }; // default readOnlyHint: true
  example?: string;              // one-line example question, shown on the docs page
  execute(input: z.infer<I>, ctx: ToolContext): Promise<ToolResult>;
}

export function defineTool<I extends z.ZodObject>(def: ToolDef<I>): ToolDef<I> { return def; }
```

Errors: tools throw `new ToolError(code, message)` (`code`: `not_found | bad_input | upstream | unavailable`). The kit turns it into `isError: true` with the message, and the metrics status becomes `error` with `code`. Any other throw → `isError: true`, message `"Internal error"`, logged with the stack, status `error`, code `internal`.

### 3.4 Config (`mcp.config.ts` in the clone root)

```ts
export default defineConfig({
  slug: "example",               // [a-z0-9-], used for dataset name and dashboard path
  name: "Example MCP",
  version: "0.1.0",
  description: "One paragraph for the docs page.",
  scopes: { "private:read": "Read private example data" }, // every private tool's scope must be listed
  tools: [getTimeTool, whoamiTool],
  docs: { contact: "hello@perxel.com" },
});
```

`defineConfig` validates at startup-time in tests: unique tool names, each private tool has a scope that exists in `scopes`, slug format. The kit's entry is `kit/core/worker.ts` exporting `createWorker(config)` which returns the Worker `{ fetch }`. The clone's `src/index.ts` is just `export default createWorker(config)`.

### 3.5 Gate and OAuth wiring (the one-Worker shape, no internal APIs needed)

```
fetch(request):
  route /health, /, /.well-known/oauth-protected-resource* → kit handlers
  if POST /mcp:
     rate limit (3.8) → 429 JSON-RPC error if over
     toolName = header "Mcp-Name" if method header "Mcp-Method" == "tools/call"
                else parse a clone of the body: JSON-RPC {method:"tools/call", params:{name}}
                (if the body is an array, collect every tools/call name)
     tool = lookup(toolName); needsAuth = any tool.access === "private"
     if !needsAuth and no Authorization header → call mcpHandler directly (auth = null)
     if needsAuth and no Authorization header → 401 (below)
     otherwise → oauthProvider.fetch(request)  // it validates the bearer token and calls apiHandler,
                                               // or itself answers 401 invalid_token
  everything else → oauthProvider.fetch(request) (its defaultHandler = Access sign-in + consent)

apiHandler (only reached with a valid token; OAuthProvider apiRoute = "/mcp"):
  props = ctx.props (userId, email, scopes stored at completeAuthorization)
  for each private tool in the request: if tool.scope not in grant scopes →
     403 with WWW-Authenticate: Bearer error="insufficient_scope", scope="<all still-needed scopes, space-separated>",
         resource_metadata="<publicUrl>/.well-known/oauth-protected-resource/mcp"
  → mcpHandler with auth
```

401 response: status 401, body JSON `{"error":"unauthorized"}`, header
`WWW-Authenticate: Bearer resource_metadata="<publicUrl>/.well-known/oauth-protected-resource/mcp", scope="<tool.scope>"`.

OAuthProvider options: `apiRoute: "/mcp"`, `authorizeEndpoint: "/authorize"`, `tokenEndpoint: "/token"`, `clientRegistrationEndpoint: "/register"`, `scopesSupported: Object.keys(config.scopes)`, CIMD on, refresh token rotation on, PKCE S256 only. Check the real option names in the `.d.ts` (rule 4).

Allowed redirect URIs: `https://claude.ai/api/mcp/auth_callback`, `http://localhost/callback` and `http://127.0.0.1/callback` with any port. Anything else → the consent page refuses with a clear error. (DCR stays on, but redirect URIs are still checked against this list in v1.)

Consent page (`kit/core/consent.ts`): plain HTML, no JS frameworks. Shows the MCP name, the client name, the **redirect hostname**, the scopes with their descriptions from config, Allow/Deny buttons. A yellow warning when the redirect host is `localhost` or `127.0.0.1` ("This app runs on your own computer"). Use the library's consent helpers for CSRF and remembered consent; add `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`.

Access sign-in (`kit/core/access.ts`, the only file that knows about Access): redirect to `ACCESS_AUTHORIZATION_URL`, handle `/callback`, exchange the code at `ACCESS_TOKEN_URL`, verify the id_token against `ACCESS_JWKS_URL`, then `completeAuthorization({ userId: sub, scope: granted, props: { userId: sub, email, scopes: granted } })`.

### 3.6 Metrics row (write this table verbatim into `STANDARD.md`)

One `writeDataPoint` per `tools/call` (not per `tools/list`), written in `ctx.waitUntil`, never failing the request.

| Field | Content |
|---|---|
| `indexes[0]` | caller key: `u:` + first 16 hex of SHA-256(salt + userId) when signed in, else `ip:` + first 16 hex of SHA-256(salt + ip + Vietnam date) |
| `blobs[0]` | slug |
| `blobs[1]` | tool name (`unknown` if not found) |
| `blobs[2]` | status: `ok`, `error`, `invalid_input`, `unauthorized`, `forbidden`, `rate_limited` |
| `blobs[3]` | error code or `""` |
| `blobs[4]` | client family: `claude-ai` (IP in Anthropic range), `claude-code`, `inspector`, `other` (from 2026 client identity `clientInfo.name`, else User-Agent) |
| `blobs[5]` | access: `public` or `private` |
| `blobs[6]` | auth: `anon` or `user` |
| `blobs[7]` | country (`request.cf.country` or `""`) |
| `blobs[8]` | protocol era: `modern` or `legacy` |
| `blobs[9]` | kit version (from `kit/VERSION`) |
| `doubles[0]` | latency ms |
| `doubles[1]` | result count, `-1` when not a list |
| `doubles[2]` | response bytes |

Never tool arguments, emails, raw IPs, user ids, or tokens. 401/403/429 on a `tools/call` also produce a row.

### 3.7 `/health`

```json
{ "ok": true, "name": "...", "slug": "...", "version": "0.1.0", "kit": "<kit version>",
  "sources": { "content": { "from": "memory|fetch|kv-fallback|empty", "fetchedAt": "ISO", "etag": "...", "items": 26 } } }
```
`ok` is false (HTTP 503) only when a required source is `empty`. `sources` is `{}` when the clone has none.

### 3.8 Rate limit

Before the gate. Anthropic range → `RATE_LIMITER_ANTHROPIC` key `anthropic`. Otherwise `RATE_LIMITER` keyed by caller key (the user key if a bearer token was present and valid is not known yet at this point, so use the IP key; that's fine for v1). Over the limit: HTTP 429, `Retry-After: 60`, JSON-RPC error body `{"jsonrpc":"2.0","id":<id or null>,"error":{"code":-32000,"message":"Rate limit exceeded, retry in a minute"}}`. Missing binding (tests, local) → allow.

### 3.9 Static JSON source (`kit/core/static-source.ts`)

```ts
export function createStaticSource<T>(opts: {
  name: string;              // "content", shown in /health
  url: (env) => string;
  kvKey: string;             // key in CONTENT_KV
  maxAgeMs?: number;         // default 600_000
  parse: (json: unknown) => T; // validate with zod; throw on bad shape
  count?: (data: T) => number;
}): { get(env, ctx): Promise<T>; status(): SourceStatus };
```
Order exactly as the plan's "loading order": memory (fresh) → conditional fetch with `If-None-Match` (304 keeps memory and bumps fetchedAt) → on 200 parse, keep in memory, write KV only if the ETag or a SHA-256 of the body changed (store `{etag, hash, fetchedAt, body}`) → on fetch/parse failure use memory if present even if stale, else KV → else throw `ToolError("unavailable", "Content is not available yet")`. Concurrent calls share one in-flight fetch. Tests cover each branch with a fake `fetch` and fake KV.

Helpers next to it (`kit/core/search.ts`): `searchItems(items, query, { fields, limit })` using `foldText` on both sides, scoring title matches above body matches; `bySlug(items, slug)`; `clampLimit(n, default 5, max 20)`.

### 3.10 `kit:update`

`kit.json` in the repo root: `{ "repo": "perxel/perxel-mcp-kit", "ref": "main" }`.
`pnpm kit:update [ref] [--from <local path>]`:
1. Refuse if `git status --porcelain kit/` is not empty.
2. Get the kit: `--from` copies `<path>/kit`; otherwise download `https://codeload.github.com/<repo>/tar.gz/<ref>` to a temp dir and extract only `*/kit/`.
3. Replace `kit/` entirely, write `kit/VERSION` as `<ref>@<short sha or "local">`.
4. Compare `kit/deps.json` (a list of the packages and exact versions the kit needs) with the clone's `package.json` and print any that differ with the `pnpm add` command to fix them. Don't edit package.json automatically.
5. Print `git diff --stat kit/`.
The `--from` option lets a clone pick up kit changes before they are pushed, and is what the tests use.

### 3.11 Metrics proxy (`kit/metrics-proxy/`, its own Worker and `wrangler.proxy.jsonc`)

- Secret `CF_API_TOKEN` (Account Analytics Read), var `CF_ACCOUNT_ID`, secret `PROXY_KEYS`: JSON `{ "<sha256 hex of key>": "mcp_perxel", ... }`.
- Accepts what the Altinity ClickHouse plugin sends (check the plugin docs for GET `?query=` vs POST body; support both). Auth: `Authorization: Bearer <key>` (or the plugin's basic-auth password field if that's what it can send; support both and document which to use).
- Validation, before forwarding (`kit/metrics-proxy/validate.ts`, pure function, heavily tested): strip string literals and comments; reject if it contains `;` followed by anything, `system.`, `INTO`, `ATTACH`, or any `FROM`/`JOIN` target that is not exactly the key's dataset (also reject quoted or backticked identifiers that don't match). Allow `FROM <dataset>` with and without `FORMAT JSON`.
- Forward to `https://api.cloudflare.com/client/v4/accounts/<CF_ACCOUNT_ID>/analytics_engine/sql` with the real token; return the body and status as-is.
- Tests: allowed query; another dataset; `UNION` to another dataset; subquery to another dataset; comment-hidden table; string literal containing `FROM other`; missing/wrong key; two statements.

### 3.12 Dashboard (`kit/dashboard/`)

- `Dockerfile`: `FROM grafana/grafana-oss:<pinned>`; install the pinned ClickHouse plugin at build time; copy `provisioning/` and `dashboards/` in.
- Grafana env: `GF_SERVER_ROOT_URL=https://dash.perxel.com/<slug>/`, `GF_SERVER_SERVE_FROM_SUB_PATH=true`, `GF_AUTH_ANONYMOUS_ENABLED=true`, `GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer`, `GF_AUTH_DISABLE_LOGIN_FORM=true`, `GF_EXPLORE_ENABLED=false`, `GF_USERS_ALLOW_SIGN_UP=false`, `GF_ANALYTICS_REPORTING_ENABLED=false`, `GF_PATHS_PROVISIONING=/etc/grafana/provisioning`.
- Data source provisioning: the ClickHouse plugin pointed at the proxy URL, key from env `PROXY_KEY` (`$__env{PROXY_KEY}` or `${PROXY_KEY}` syntax, check the Grafana docs).
- Base dashboard JSON (`kit/dashboard/base.json`), panels over the 3.6 row, variable-free SQL using `$timeFilter`: calls over time by tool; status breakdown (stacked); error rate %; p50/p95 latency by tool; calls by client family; unique caller keys per day; top tools table; rate-limited count; auth anon vs user.
- Container Worker (`kit/dashboard/worker.ts`, `wrangler.dash.jsonc` in the clone): a `Container` class from `@cloudflare/containers`, instance type `basic` to start (adjust after the memory check), `sleepAfter: "10m"`, forwards requests under `/<slug>/` to the container on port 3000, passes `PROXY_KEY` (secret) as env.
- Clone extras: every `dashboards/*.json` in the clone is copied into the image next to `base.json`.
- Local check: if `docker` is available, `docker build` and `docker run` the image and `curl` `/api/health` and the dashboard JSON; if not (the case on this machine), record it in `001-notes.md`.

## 4. Tasks

Each task: do it, run `pnpm typecheck && pnpm test`, tick it in section 5, commit. End of each phase: `git push origin main`.

**Phase 1: kit core**
- 1.1 Scaffold: `package.json` (section 2), `pnpm-workspace.yaml`, `tsconfig.json`, `.gitignore` (`node_modules`, `.dev.vars`, `.wrangler`, `.idea`, `dist`), `wrangler.mcp.jsonc` (section 3.2), `.dev.vars.example`, `vitest.config.ts`, `kit.json` (3.10), the dirs from the plan's repo layout (`dashboards/` and `evals/` with a `.gitkeep` if empty), `kit/VERSION` = `dev`, `kit/deps.json`. Accept: `pnpm install` and `pnpm typecheck` pass.
- 1.2 `kit/core/tool.ts`, `kit/core/config.ts` (3.3, 3.4) with tests for each config validation error.
- 1.3 `kit/core/worker.ts` + MCP handler: an `McpServer` per request from `config.tools` (stateless `createMcpHandler`, `legacy: "stateless"`, `cacheHints` for `tools/list` with `ttlMs: 300000`), wrap `execute` to produce `content` + `structuredContent`, `ToolError` handling. Routes from 3.1; the OAuth ones return 501 until phase 3.
- 1.4 Example tools in `src/tools/`: `get_time` (public: current time in an IANA timezone, default `Asia/Ho_Chi_Minh`) and `whoami` (private, scope `private:read`, returns `ctx.auth.userId` and `email`). `mcp.config.ts`, `src/index.ts`. Unit tests for both (whoami called directly with a fake `ctx.auth`).
- 1.5 Rate limit + caller key (3.8), metrics row (3.6), structured logs (`console.log(JSON.stringify({...}))`), `/health` (3.7), docs page (`GET /`: every tool with name, title, description, public/private badge, example; connect steps for Claude: Settings → Connectors → Add custom connector → paste `<publicUrl>/mcp`). Tests: metrics row fields for ok / error / invalid input; 429 path; Anthropic-range bucket; health shape; docs page contains every tool name.
- 1.6 Protocol test (`kit/testing/protocol.test.ts`, written so a clone can run it against its own config): using the SDK's client in-process against `worker.fetch`: tools list matches config, every input schema is an object schema, `get_time` call works, a bad argument returns `isError: true`, a 2025-era client (`initialize` then `tools/list`, protocol version `2025-06-18`) works.
- 1.7 Evals: `kit/testing/eval.ts` reads `evals/questions.md` (each question: text, expected tool(s), expected facts) and, given `--url <mcp url>`, calls the expected tools with the listed arguments and checks the facts appear in the result. It must refuse any URL that isn't `localhost`/`127.0.0.1` unless `--allow-remote` is passed (the "never point a local client at production" rule). `evals/questions.md`: 3 questions for the example tools. Unit-test the parser.
- 1.8 `STANDARD.md`: the checklist from the plan (protocol, tools and token rules, auth, limits, metrics row 3.6 verbatim, monitoring, tests, costs, dev rules). Bullets, one short section per topic.
- Push.

**Phase 2: kit:update and static JSON source**
- 2.1 `kit/update/update.ts` (3.10). Tests for the pure parts (dirty-check parsing, deps comparison) plus an integration test: copy the repo to an OS temp dir, change a file in its `kit/`, run the update with `--from <this repo>`, assert `kit/` matches and `kit/VERSION` ends in `@local`, then delete the temp dir. Don't download from GitHub in tests.
- 2.2 `kit/core/static-source.ts`, `search.ts`, `fold-text.ts` (3.9). Fixture `kit/testing/fixtures/content.json` (8 made-up items, some with Vietnamese diacritics) in the shape below, which is also the documented recommended shape for static sources in `STANDARD.md`. Tests: every loading-order branch, shared in-flight fetch, KV written only on change, diacritic-insensitive search (`"thiet ke"` finds `"Thiết kế"`), `clampLimit`, list items never contain `body`.
  ```json
  { "version": 1, "generatedAt": "ISO",
    "site": { "name": "...", "url": "...", "email": null, "phone": null, "address": null, "socials": {} },
    "items": [ { "type": "...", "slug": "...", "title": "...", "excerpt": "≤300 chars", "url": "...",
                 "category": "...", "date": "YYYY-MM-DD or null", "tags": [], "body": "plain text" } ] }
  ```
- Push.

**Phase 3: OAuth**
- 3.1 Protected resource metadata, OAuthProvider wiring and the gate exactly as 3.5; `kit/core/access.ts` adapted from the Cloudflare template; consent page.
- 3.2 Gate tests (`kit/testing/gate.test.ts`): public call without token → 200; private call without token → 401 with the exact `WWW-Authenticate` format; `Mcp-Name` header path and body-fallback path both; batch containing one private call → 401; valid token lacking the scope → 403 `insufficient_scope`; valid token with the scope → 200 and `whoami` returns the user; metadata `resource` equals `<publicUrl>/mcp`; metadata advertises `S256`, `"none"` in `token_endpoint_auth_methods_supported` and `client_id_metadata_document_supported: true`; token endpoint accepts form-urlencoded; a dead refresh token → `invalid_grant`; a redirect URI outside the allowed list is refused; consent page shows the redirect hostname and the localhost warning. To get a real token in tests, drive the provider flow in-process with `kit/testing/oauth-helper.ts`: register a client via `/register`, call `/authorize`, stub the Access step (fake token endpoint + a JWKS made from a key generated in the test), approve consent, exchange the code at `/token`.
- Push.

**Phase 4: metrics proxy and dashboard**
- 4.1 Metrics proxy (3.11) with the validation tests. `wrangler.proxy.jsonc` at the repo root.
- 4.2 Dashboard (3.12). Docker isn't installed here, so validate statically: a test that `base.json` and every `dashboards/*.json` is valid Grafana dashboard JSON (has `panels`, each panel has a SQL target that uses `$timeFilter` and reads from the dataset), the provisioning YAML parses (write a tiny check or use a pinned `yaml` devDependency; allowed exception to rule 6), and `wrangler.dash.jsonc` typechecks with the worker. Record in `001-notes.md` that the container, the plugin through the proxy, Grafana's memory use and cold start are unverified (plan "To verify during the build").
- Push.

**Phase 5: docs and final report**
- 5.1 `README.md`: what the kit is; create a new MCP from the template, step by step (use the template, set `mcp.config.ts`, write tools, `pnpm dev`, tests, evals); a "Human setup before first deploy" section listing every Cloudflare step and command (Workers Paid, KV namespaces, Access for SaaS OIDC app with redirect `https://<host>/callback` and one-time PIN, the secrets, rate-limit namespace ids, custom domain, AE dataset, proxy key, dashboard route and Access rule); `kit:update` usage. `TRANSFER.md`: redeploy + secrets into another account; what stays behind (OAuth tokens in KV, metrics history). `LICENSE`: the exact PolyForm Shield 1.0.0 text fetched from `https://polyformproject.org/licenses/shield/1.0.0/` (never from memory), with `Required Notice: Copyright (c) 2026 Perxel (https://perxel.com)`.
- 5.2 Final report at the top of `001-notes.md` (rule 9). Final `pnpm typecheck && pnpm test`, commit, push.

## 5. Checklist

- [x] 1.1 scaffold
- [x] 1.2 tool + config
- [x] 1.3 worker + MCP handler
- [x] 1.4 example tools
- [x] 1.5 rate limit, metrics, logs, health, docs page
- [x] 1.6 protocol test
- [x] 1.7 evals
- [x] 1.8 STANDARD.md
- [x] 2.1 kit:update
- [x] 2.2 static source + search
- [x] 3.1 OAuth + gate + Access + consent
- [x] 3.2 gate tests
- [x] 4.1 metrics proxy
- [x] 4.2 dashboard
- [x] 5.1 README, TRANSFER, LICENSE
- [x] 5.2 final report, push
