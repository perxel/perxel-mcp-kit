/**
 * Test-only stand-in for the `cloudflare:workers` runtime module. The real
 * module exists only inside workerd; vitest runs in plain Node, while
 * `@cloudflare/workers-oauth-provider` imports `WorkerEntrypoint` from it at
 * module top (solely for `instanceof` checks — our handlers are plain
 * `{ fetch }` objects, so the stub class is never instantiated). Wired up via
 * `resolve.alias` in `vitest.config.ts`; production is unaffected.
 */
export class WorkerEntrypoint<Env = unknown, Props = unknown> {
  declare env: Env;
  declare ctx: ExecutionContext & { props: Props };
  constructor(_ctx?: unknown, _env?: unknown) {}
  fetch(_request: Request): Response | Promise<Response> {
    throw new Error("stub WorkerEntrypoint has no fetch");
  }
}
