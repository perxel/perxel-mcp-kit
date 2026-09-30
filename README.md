# Perxel MCP Kit

A public template for building a remote MCP server plus its monitoring
dashboard, 100% on Cloudflare. Perxel sells MCP setup and hosting as a
service; this kit is the single source of truth every Perxel-built MCP
follows. See `STANDARD.md` for the checklist.

Source-available under the PolyForm Shield 1.0.0 license (`LICENSE`): free
to use and modify, not to resell or offer as a competing service. This is
**not** open source (OSI).

v1 is tested and supported for **Claude only** (claude.ai web, Desktop,
mobile, Claude Code).

## What's inside

```
STANDARD.md          SSOT checklist: protocol, tools, auth, limits, metrics row, monitoring, tests, costs
kit/                 owned by the kit; clones never edit (updated via pnpm kit:update)
  core/              gate, OAuth + Access sign-in, consent page, rate limit, metrics, logs, health, docs page
  metrics-proxy/     Worker holding the only Analytics Engine token; scopes each key to one dataset
  dashboard/         Grafana container engine + base dashboard
  testing/           protocol test + eval helpers
  update/            the kit:update script
src/tools/           small generic example (one public, one private tool)
mcp.config.ts        example config
dashboards/          example extras (empty)
evals/               example questions
wrangler.mcp.jsonc, wrangler.dash.jsonc, wrangler.proxy.jsonc
```

## Create a new MCP from the template

1. **Use the template.** On GitHub: Use this template → create your repo
   (e.g. `khatra-mcp`), then clone it. Or clone and re-point the remote.
2. **Install.** `pnpm install` (Node 22, pnpm 10.22.0).
3. **Set `mcp.config.ts`.** Change `slug` (`[a-z0-9-]`, used for the
   Analytics Engine dataset `mcp_<slug>` and the dashboard path
   `dash.perxel.com/<slug>`), `name`, `version`, `description`, `scopes`
   (every private tool's scope must be listed), and the `tools` list.
   Point `MCP_PUBLIC_URL` in `wrangler.mcp.jsonc` at the future public URL
   (e.g. `https://khatra-mcp.perxel.com`); keep
   `http://localhost:8788` in `.dev.vars` for local dev
   (copy `.dev.vars.example` to `.dev.vars` and fill it in).
4. **Write tools.** Add files in `src/tools/` with `defineTool` from
   `kit/core/tool.ts`: `name` (snake_case), `title`, `description` (what it
   returns, units, freshness, limits), `access: "public" | "private"` (plus a
   `scope` when private), a zod `inputSchema`, and `execute(input, ctx)`.
   Keep the token rules from `STANDARD.md`: list/search tools return compact
   items only (title, slug, excerpt, URL, category — never full text), full
   text comes only from a detail tool for one item, every list has a `limit`
   (default 5, max 20), no "dump everything" tool. Errors: throw
   `new ToolError("not_found" | "bad_input" | "upstream" | "unavailable", msg)`;
   anything else becomes `"Internal error"`. Use `kit/core/static-source.ts`
   + `kit/core/search.ts` for static JSON sources (diacritic-insensitive
   search included), or call your API directly in `execute()`.
5. **Run it.** `pnpm dev` starts `wrangler dev` (port 8788) plus the MCP
   Inspector (port 8002). Connect instructions and the tool list are at
   `GET /`; `GET /health` reports version and source status.
6. **Tests.** `pnpm typecheck && pnpm test`. Includes unit tests per tool,
   the protocol test (`kit/testing/protocol.test.ts`, runs against your own
   config), and the gate tests (200 / 401 / 403).
7. **Evals.** Edit `evals/questions.md` (one `##` question: `- tool:` lines
   with JSON args, `- expect:` lines with facts that must appear), then
   `pnpm eval --url http://localhost:8788/mcp` against `wrangler dev`.
   The eval refuses any non-localhost URL unless `--allow-remote` is passed:
   never point a local client at a production URL.
8. **Clones never edit `kit/`.** Kit fixes arrive via `pnpm kit:update`
   (see below).

## Human setup before first deploy

Do these once per MCP, in the Cloudflare dashboard unless a command is
given. Nothing below is automated by the kit on purpose.

1. **Workers Paid plan** ($5/month) on the account. Don't run clients on the
   free plan (its 10 ms CPU cap per request is a real risk).
2. **KV namespaces.** Create two and paste the ids into
   `wrangler.mcp.jsonc`:
   `wrangler kv namespace create OAUTH_KV`,
   `wrangler kv namespace create CONTENT_KV`
   (`CONTENT_KV` only if a static JSON source is used).
3. **Access for SaaS OIDC app** (the sign-in). Zero Trust → Access →
   create an OIDC SaaS app: redirect URI `https://<host>/callback`
   (e.g. `https://khatra-mcp.perxel.com/callback`), login method email
   one-time PIN (or another identity provider). Note the client ID,
   client secret, token URL, authorization URL and JWKS URL.
4. **Secrets** (never commit values; `wrangler secret put -c wrangler.mcp.jsonc <name>`):
   `IP_HASH_SALT`, `COOKIE_ENCRYPTION_KEY`, `ACCESS_CLIENT_ID`,
   `ACCESS_CLIENT_SECRET`, `ACCESS_TOKEN_URL`, `ACCESS_AUTHORIZATION_URL`,
   `ACCESS_JWKS_URL`.
5. **Rate-limit namespace ids.** In `wrangler.mcp.jsonc`, change
   `RATE_LIMITER` / `RATE_LIMITER_ANTHROPIC` `namespace_id`s to values
   unique in the account (template uses `"1001"` / `"1002"`).
6. **Custom domain.** Workers → the MCP Worker → Custom Domains (or Routes):
   `<slug>-mcp.perxel.com` (covered by the free `*.perxel.com`
   certificate). Set `MCP_PUBLIC_URL` in `wrangler.mcp.jsonc` to exactly
   `https://<host>` — OAuth `resource` must equal the URL users paste
   (plus `/mcp`).
7. **Deploy the MCP Worker.** `wrangler deploy -c wrangler.mcp.jsonc`
   (only after approval).
8. **Metrics proxy.** In `wrangler.proxy.jsonc` set `CF_ACCOUNT_ID`; set
   secrets `CF_API_TOKEN` (token with Account Analytics Read — account-wide,
   the proxy holds the only copy) and `PROXY_KEYS` (JSON mapping each
   dashboard key's SHA-256 hex to its dataset, e.g.
   `{"<sha256 of khatra key>": "mcp_khatra"}`; hash with
   `echo -n '<key>' | sha256sum`). Deploy the proxy Worker.
   The Analytics Engine dataset (`mcp_<slug>`) is created implicitly on
   first `writeDataPoint`.
9. **Dashboard.** In `wrangler.dash.jsonc` set `SLUG`, `PROXY_URL`, and
   `image_vars.DATASET` (`mcp_<slug>`); set secret `PROXY_KEY` (this
   dashboard's key). Add a Worker route for `dash.perxel.com/<slug>/*` and
   a Cloudflare Access rule protecting `/<slug>` (staff logins and dashboard
   viewers share the 50-seat Zero Trust free pool, then ~$7/user/month).
   Deploy the dashboard Worker.
10. **Test the flow.** In Claude: Settings → Connectors → Add custom
    connector → paste `https://<host>/mcp`. Public tools work immediately;
    calling a private tool shows a Connect card → Access one-time PIN →
    Allow/Deny consent → Claude retries the call. Check
    `dash.perxel.com/<slug>` for the metrics row.

## `kit:update`

Pulls the latest `kit/` from the kit repo without touching the clone's own
files (`src/tools/`, `mcp.config.ts`, `dashboards/`, `evals/`, wrangler
configs):

```
pnpm kit:update [ref] [--from <local path>]
```

- Refuses if `git status --porcelain kit/` is not empty (commit first).
- Default source is `kit.json` (`repo` + `ref`, tarball from GitHub);
  `--from` copies from a local checkout (picks up unpushed kit changes;
  what the tests use).
- Replaces `kit/` entirely, writes `kit/VERSION` as `<ref>@<short sha>`,
  compares `kit/deps.json` against the clone's `package.json` and prints
  any mismatches with the `pnpm add` command to fix them (never edits
  `package.json` automatically), then prints `git diff --stat kit/`.
- Review the diff, run `pnpm typecheck && pnpm test`, commit.

## Transferring to a client's account

See `TRANSFER.md`.
