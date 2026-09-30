# TRANSFER.md — move an MCP deployment to a client's Cloudflare account

There is no "move a Worker to another account" in Cloudflare. A transfer is
a redeploy plus secrets into the client's account, then a DNS cutover.

## Steps

1. In the client's account: Workers Paid plan, the two KV namespaces
   (`OAUTH_KV`, plus `CONTENT_KV` if a static source is used), the Access
   for SaaS OIDC app (redirect `https://<host>/callback`), and the custom
   domain — same checklist as "Human setup before first deploy" in
   `README.md`, but with fresh values.
2. Set all secrets fresh in the new account (`wrangler secret put` for the
   MCP Worker, the metrics proxy, and the dashboard Worker). Never export
   secret values out of the old account; generate new salts/keys where
   possible (`IP_HASH_SALT`, `COOKIE_ENCRYPTION_KEY`, dashboard `PROXY_KEY`).
   The Access OIDC client ID/secret and the Analytics Engine token are new
   by construction.
3. Give the rate limiters new `namespace_id`s unique in the new account.
4. Deploy the three Workers (`wrangler deploy` with each `-c` config) and
   re-create the dashboard Worker route plus Access rule for `/<slug>`.
5. Cut over DNS / the custom domain to the new account, then have every
   user remove the old connector in Claude and add the new URL — OAuth
   tokens are tied to the URL, so a re-add plus one sign-in is required
   (on Team/Enterprise an org Owner re-adds once for everyone). The Worker
   can serve both URLs during a transition.
6. Verify: `/health`, a public tool call, a private tool's Connect card,
   and the dashboard panels, then decommission the old Workers.

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
