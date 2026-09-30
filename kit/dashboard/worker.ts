/**
 * Dashboard Worker (section 3.12 of the task list): serves the Grafana
 * container from `kit/dashboard/Dockerfile` under `/<slug>/` on
 * dash.perxel.com. One Worker per client (one slug, one Grafana, one proxy
 * key); Cloudflare Access rules per path keep each dashboard private while
 * Grafana itself runs anonymous read-only (see the Dockerfile env).
 *
 * Runtime config comes from vars/secrets so clones never edit this file:
 * Grafana's sub-path URL, the metrics-proxy URL and the dashboard key are
 * passed into the container as env, where the provisioned data source reads
 * them via `$__env{...}`.
 */

import { Container, getContainer } from "@cloudflare/containers";

export interface DashEnv {
  /** Durable Object binding for the Grafana container. */
  GRAFANA: DurableObjectNamespace<Grafana>;
  /** Client slug: served at https://dash.perxel.com/<slug>/. */
  SLUG?: string;
  /** Metrics-proxy URL for this client (container env PROXY_URL). */
  PROXY_URL?: string;
  /** This dashboard's proxy key (secret, container env PROXY_KEY). */
  PROXY_KEY?: string;
  [key: string]: unknown;
}

export class Grafana extends Container<DashEnv> {
  defaultPort = 3000;
  sleepAfter = "10m";

  constructor(ctx: ConstructorParameters<typeof Container>[0], env: DashEnv) {
    super(ctx, env);
    // Read at container start: Grafana picks GF_* up on boot, and the
    // provisioned data source interpolates PROXY_URL/PROXY_KEY via $__env.
    const slug = typeof env.SLUG === "string" && env.SLUG !== "" ? env.SLUG : "example";
    this.envVars = {
      GF_SERVER_ROOT_URL: `https://dash.perxel.com/${slug}/`,
      ...(typeof env.PROXY_URL === "string" && env.PROXY_URL !== "" ? { PROXY_URL: env.PROXY_URL } : {}),
      ...(typeof env.PROXY_KEY === "string" && env.PROXY_KEY !== "" ? { PROXY_KEY: env.PROXY_KEY } : {}),
    };
  }
}

export default {
  async fetch(request: Request, env: DashEnv): Promise<Response> {
    const slug = typeof env.SLUG === "string" && env.SLUG !== "" ? env.SLUG : "example";
    const url = new URL(request.url);
    if (url.pathname === `/${slug}`) {
      return Response.redirect(`${url.origin}/${slug}/`, 308);
    }
    if (!url.pathname.startsWith(`/${slug}/`)) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    // Grafana serves from the sub-path itself (SERVE_FROM_SUB_PATH), so the
    // request forwards unchanged; a single instance serves this dashboard.
    return getContainer(env.GRAFANA, "grafana").fetch(request);
  },
};
