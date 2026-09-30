# Perxel MCP Standard (SSOT)

Every Perxel-built MCP follows this checklist. The kit enforces it; clones inherit it via `pnpm kit:update`.

## Protocol

- `@modelcontextprotocol/server` v2, spec 2026-07-28, stateless (`createMcpHandler`), with the default fallback for 2025-era clients.
- MCP endpoint is `POST /mcp` on the Worker's custom domain; `GET`/`DELETE /mcp` answer 405 (SDK default).
- `GET /` is a docs page generated from the tool definitions; `GET /health` reports version and source status.
- The MCP URL users paste is `https://<host>/mcp`; one-level subdomains on `perxel.com` (covered by the free `*.perxel.com` certificate).

## Tools and token rules

- 5–10 tools per MCP; past ~15–20, model tool selection gets worse.
- Each tool declares `access: "public" | "private"` plus a scope when private.
- Tools are read-only by default; write tools carry different risk and liability (price separately).
- Only what a tool returns reaches the AI and costs tokens:
  - List and search tools return compact items only: title, slug, a short excerpt, URL and category. Never full text.
  - Full text comes only from a detail tool, for one item (e.g. `get_insight(slug)`).
  - Every list has a `limit` with a small default (e.g. 5, max 20).
  - No "dump everything" tool. Even `list_all` returns titles and slugs only.
- A typical question (one search, maybe one detail) is ~1–4k tokens.
- Unknown is `null`, not 0; state units (VND) and freshness in descriptions.
- Never put upstream admin keys in the MCP Worker (a narrow shared secret only).
- Data goes straight into model context: treat descriptions/reviews as untrusted (prompt injection).

## Auth

- OAuth via `@cloudflare/workers-oauth-provider`: CIMD and DCR both on, PKCE S256, refresh-token rotation, RFC 9207.
- Sign-in is Cloudflare Access for SaaS as OIDC (email one-time code), kept in one file (`kit/core/access.ts`) so it can be swapped.
- Lazy authentication on one server: public calls pass through; a private call without a valid token is a real HTTP 401 with `WWW-Authenticate: Bearer resource_metadata=..., scope=...` so Claude shows a Connect card (a 200 tool error does not start sign-in); a token without the needed scope is 403 `insufficient_scope`.
- Claude requirements: redirect URIs `https://claude.ai/api/mcp/auth_callback` plus port-agnostic `http://localhost/callback` and `http://127.0.0.1/callback`; `resource` exactly equals the MCP URL; token endpoint accepts form-urlencoded; discovery/registration/token answer in under 10 s, refresh in under 30 s; `invalid_grant` for dead refresh tokens.
- v1 supports Claude only (claude.ai web, Desktop, mobile, Claude Code).

## Limits

- 60/min per caller (salted IP hash, rotating daily on Vietnam time) when anonymous, per user when signed in.
- 600/min shared bucket for Anthropic's cloud range `160.79.104.0/21` (claude.ai calls from a few IPs on behalf of many users; a per-IP limit alone is wrong).
- Over the limit: HTTP 429, `Retry-After: 60`, JSON-RPC error `-32000`.
- Rate-limiter `namespace_id`s are unique per Cloudflare account: change per MCP.
- Run clients on Workers Paid, not free (the free 10 ms CPU cap per request is a real risk).

## Metrics row

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

- Analytics Engine: one dataset per MCP (`mcp_<slug>`, `-` → `_`), 3-month retention.
- Static JSON sources additionally keep a last-good copy in KV, written only when content changes.

## Monitoring

- Workers Logs: structured JSON lines (`console.log(JSON.stringify(...))`), no personal data, no tool arguments.
- `/health` returns `{ok, name, slug, version, kit, sources}`; `ok` is false (HTTP 503) only when a required source is `empty`. Each source reports where its copy came from (`memory`, `fetch` or `kv-fallback`) so a stale fallback is visible.
- Grafana dashboard per client at `dash.perxel.com/<slug>` (private, Access-protected), reading through the metrics proxy, which holds the only Analytics Engine token and scopes each key to one dataset.
- Dashboard edits made in the Grafana UI are lost on container sleep: design in Grafana, export the JSON, commit, deploy.

## Tests

- `pnpm typecheck && pnpm test` passes after every change; never delete or weaken a test to make it pass.
- Unit tests per tool; protocol test (tool list, schemas, a call, a validation error, 2025-client compatibility) runs against the clone's own config; gate tests (200 / 401 / 403); eval questions in `evals/` run against `wrangler dev` or a deployed URL.
- Eval and dev clients only ever point at `localhost`/`127.0.0.1` unless `--allow-remote` is passed.

## Costs (checked 2026-09-30)

- Workers Paid $5/month: 10M requests then $0.30/M, 30M CPU-ms then $0.02/M. Covers the MCPs, KV, the proxy and containers at small-client scale.
- Containers: included in Workers Paid (375 vCPU-min, 25 GiB-h, 200 GB-h/month), billed only while running.
- Zero Trust: 50 free users shared across all clients (staff logins plus dashboard viewers), then ~$7/user/month. Keep a margin over $84/user/year past 50 total.
- LLM tokens are paid by the user's AI subscription, not by the MCP. An on-site chatbot is a separate product with its own token cost.

## Dev rules

- Never deploy, log in to, or change a Cloudflare account from a dev machine without asking (`wrangler deploy`, `secret put`, `kv namespace create`, DNS/dashboard changes).
- Never point a local client at a production URL.
- Clones never edit `kit/`; kit changes land via `pnpm kit:update`.
- Pinned versions only; the installed `.d.ts` types win over any doc when an API name differs.
- Don't touch other repos (`perxel-web-2026`, `openrace-mcp`, `openwallet-mcp`) without asking.
