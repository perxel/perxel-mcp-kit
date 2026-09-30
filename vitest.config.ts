import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // `@cloudflare/workers-oauth-provider` imports `WorkerEntrypoint` from
      // `cloudflare:workers` at module top; that module only exists in workerd.
      // Tests run in plain Node, so it resolves to a stub (see the file).
      "cloudflare:workers": resolve(process.cwd(), "kit/testing/cloudflare-workers-stub.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    server: {
      // Process the provider through vite (not Node's loader) so the
      // `cloudflare:workers` alias above applies to its runtime import.
      deps: { inline: [/@cloudflare\/workers-oauth-provider/] },
    },
  },
});
