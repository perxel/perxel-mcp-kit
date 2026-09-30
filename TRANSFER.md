# TRANSFER.md — move an MCP deployment to a client's Cloudflare account

There is no "move a Worker to another account" in Cloudflare. A transfer is
a redeploy plus secrets into the client's account, then a DNS cutover.

## Steps

1. In the client's account: Workers Paid plan, the two KV namespaces
   (`OAUTH_KV`, plus `CONTENT_KV` if a static source is used), both Access
   apps (the SaaS/OIDC sign-in app with redirect `https://<host>/callback`,
   and the self-hosted app on `<host>/dash`), and an Analytics Engine read
   token. Same checklist as "Deploy" in `README.md`, with fresh values.
2. Deploy the metrics proxy in the client's account (`wrangler.proxy.jsonc`,
   its own `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `PROXY_KEYS`) unless it already
   has one. It's per account, so it never moves with the MCP.
3. Set all MCP secrets fresh (`wrangler secret put -c wrangler.mcp.jsonc`).
   Never export secret values out of the old account; generate new
   `IP_HASH_SALT`, `COOKIE_ENCRYPTION_KEY` and `DASH_PROXY_KEY` (and add the
   new key's hash to the new proxy's `PROXY_KEYS`). The Access OIDC client
   ID/secret and the Analytics Engine token are new by construction. Update
   `DASH_ACCESS_TEAM` and `DASH_ACCESS_AUD` to the client's Zero Trust values.
4. Give the rate limiters new `namespace_id`s unique in the new account.
5. Remove the custom domain from the old account's Worker, then deploy the
   MCP Worker in the new one (`wrangler deploy -c wrangler.mcp.jsonc`
   attaches the domain; the zone must be in the client's account, or use a
   host on the client's own domain).
6. Have every user remove the old connector in Claude and add the URL again:
   OAuth tokens are tied to the old account's KV, so one sign-in is required
   (on Team/Enterprise an org Owner re-adds once for everyone).
7. Verify: `/health`, a public tool call, a private tool's Connect card,
   and `/dash` behind Access, then delete the old Worker and remove its key
   from the old proxy's `PROXY_KEYS`.

## What stays behind

- **OAuth tokens in KV.** Grants, codes and refresh tokens live in the old
  account's `OAUTH_KV` and are not migrated — users sign in again, which
  mints fresh tokens. (Tokens are stored hashed; there is nothing useful
  to copy.)
- **Metrics history.** Analytics Engine rows stay in the old account; the
  new dataset starts empty. Dashboards show data only from the cutover
  date. Export anything needed for invoicing before decommissioning.
- **Static JSON last-good copy** in `CONTENT_KV` is re-fetched from the
  source URL on first use; no migration needed.
