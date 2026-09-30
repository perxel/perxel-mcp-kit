/**
 * Static validation for the dashboard (section 3.12, task 4.2).
 *
 * Docker isn't installed on the build machine, so instead of building and
 * running the image this test checks everything that can be checked
 * statically: base.json and every clone dashboards/*.json is valid Grafana
 * dashboard JSON whose every SQL target uses $timeFilter and reads from the
 * client's dataset; the provisioning YAML parses with the proxy URL and key
 * coming from container env; and wrangler.dash.jsonc lines up with the
 * dashboard Worker. The container itself, the ClickHouse plugin through the
 * proxy, and Grafana's memory use / cold start are unverified (recorded in
 * .claude/plans/001-notes.md).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const read = (rel: string): string => readFileSync(join(root, rel), "utf8");

/** Tiny JSONC stripper (only what wrangler configs use: // and block comments). */
function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  let str: string | null = null;
  while (i < text.length) {
    const c = text[i];
    if (str) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === str) str = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      str = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return JSON.parse(out) as unknown;
}

const dash = parseJsonc(read("wrangler.dash.jsonc")) as {
  main: string;
  containers: Array<{
    class_name: string;
    image: string;
    image_build_context: string;
    image_vars: Record<string, string>;
    instance_type: string;
  }>;
  durable_objects: { bindings: Array<{ name: string; class_name: string }> };
  exports: Record<string, unknown>;
};
// The client's dataset comes from the clone-owned wrangler config, so this
// test stays green after a clone stamps its own DATASET.
const dataset: string = dash.containers[0]?.image_vars?.DATASET ?? "mcp_example";

function checkDashboardJson(rel: string, minPanels: number): void {
  const doc = JSON.parse(read(rel)) as {
    panels?: Array<{ title?: string; targets?: Array<{ query?: unknown }> }>;
  };
  expect(Array.isArray(doc.panels), `${rel}: missing panels array`).toBe(true);
  expect(doc.panels!.length).toBeGreaterThanOrEqual(minPanels);
  for (const panel of doc.panels!) {
    expect(Array.isArray(panel.targets) && panel.targets.length > 0, `${rel}: panel "${panel.title}" has no targets`).toBe(
      true,
    );
    for (const target of panel.targets!) {
      expect(typeof target.query === "string" && target.query.length > 0, `${rel}: panel "${panel.title}" has a non-SQL target`).toBe(
        true,
      );
      const sql = target.query as string;
      expect(sql.includes("$timeFilter"), `${rel}: panel "${panel.title}" misses $timeFilter`).toBe(true);
      expect(new RegExp(`FROM\\s+${dataset}`, "i").test(sql), `${rel}: panel "${panel.title}" doesn't read FROM ${dataset}`).toBe(
        true,
      );
    }
  }
}

describe("dashboard base.json", () => {
  it("has the nine panels over the 3.6 metrics row", () => {
    checkDashboardJson("kit/dashboard/dashboards/base.json", 9);
    const doc = JSON.parse(read("kit/dashboard/dashboards/base.json")) as { panels: Array<{ title: string }> };
    for (const title of [
      "Calls over time by tool",
      "Status breakdown",
      "Error rate %",
      "p50/p95 latency by tool (ms)",
      "Calls by client family",
      "Unique callers per day",
      "Top tools",
      "Rate-limited calls",
      "Auth: anonymous vs signed in",
    ]) {
      expect(doc.panels.map((p) => p.title)).toContain(title);
    }
  });
});

describe("clone dashboards/ extras", () => {
  const extras = readdirSync(join(root, "dashboards")).filter((f) => f.endsWith(".json"));
  it.each(extras)("%s is valid dashboard JSON reading the dataset", (file) => {
    checkDashboardJson(`dashboards/${file}`, 1);
  });
  it("passes vacuously while the clone has no extras yet", () => {
    expect(Array.isArray(extras)).toBe(true);
  });
});

describe("provisioning YAML", () => {
  it("points the ClickHouse data source at the proxy with the key from env", () => {
    const doc = parseYaml(read("kit/dashboard/provisioning/datasources/ae.yaml")) as {
      apiVersion: number;
      datasources: Array<{
        type: string;
        url: string;
        jsonData: Record<string, unknown>;
        secureJsonData: Record<string, string>;
      }>;
    };
    expect(doc.apiVersion).toBe(1);
    const ds = doc.datasources[0];
    expect(ds.type).toBe("vertamedia-clickhouse-datasource");
    expect(ds.url).toContain("$__env{PROXY_URL}");
    expect(ds.jsonData.httpHeaderName1).toBe("Authorization");
    expect(Object.values(ds.secureJsonData).some((v) => v.includes("$__env{PROXY_KEY}"))).toBe(true);
  });

  it("loads every dashboard from files (no saved state)", () => {
    const doc = parseYaml(read("kit/dashboard/provisioning/dashboards/dashboards.yaml")) as {
      apiVersion: number;
      providers: Array<{ type: string; allowUiUpdates: boolean; options: { path: string } }>;
    };
    expect(doc.apiVersion).toBe(1);
    expect(doc.providers[0].type).toBe("file");
    expect(doc.providers[0].allowUiUpdates).toBe(false);
    expect(doc.providers[0].options.path).toBe("/var/lib/grafana/dashboards");
  });
});

describe("wrangler.dash.jsonc", () => {
  it("lines up with kit/dashboard/worker.ts", () => {
    expect(dash.main).toBe("kit/dashboard/worker.ts");
    expect(existsSync(join(root, dash.main))).toBe(true);
    const worker = read(dash.main);
    const className = dash.containers[0].class_name;
    expect(worker).toContain(`export class ${className} extends Container`);
    expect(worker).toContain('sleepAfter = "10m"');
    expect(worker).toContain("defaultPort = 3000");
    expect(worker).toContain("PROXY_KEY");
    expect(dash.durable_objects.bindings).toContainEqual({ name: "GRAFANA", class_name: className });
    expect(dash.exports[className]).toBeDefined();
  });

  it("builds the image from the repo root with the dataset stamped in", () => {
    const c = dash.containers[0];
    expect(c.instance_type).toBe("basic");
    expect(c.image_build_context).toBe(".");
    expect(existsSync(join(root, c.image))).toBe(true);
    expect(c.image_vars.DATASET).toMatch(/^mcp_[a-z0-9_]+$/);
  });
});

describe("Dockerfile", () => {
  const dockerfile = read("kit/dashboard/Dockerfile");

  it("pins the Grafana image and the ClickHouse plugin (never latest)", () => {
    const from = /^FROM\s+(\S+)/m.exec(dockerfile);
    expect(from).not.toBeNull();
    expect(from![1]).toMatch(/^grafana\/grafana-oss:\d+\.\d+\.\d+$/);
    expect(dockerfile).toContain("grafana-cli plugins install vertamedia-clickhouse-datasource 3.4.11");
  });

  it("copies provisioning, the base dashboard and the clone extras", () => {
    expect(dockerfile).toContain("COPY kit/dashboard/provisioning /etc/grafana/provisioning");
    expect(dockerfile).toContain("COPY kit/dashboard/dashboards /var/lib/grafana/dashboards/kit");
    expect(dockerfile).toContain("COPY dashboards /var/lib/grafana/dashboards/clone");
    expect(dockerfile).toContain("ARG DATASET=mcp_example");
  });

  it("sets the required Grafana env", () => {
    for (const key of [
      "GF_SERVER_ROOT_URL",
      "GF_SERVER_SERVE_FROM_SUB_PATH=true",
      "GF_AUTH_ANONYMOUS_ENABLED=true",
      "GF_AUTH_DISABLE_LOGIN_FORM=true",
      "GF_EXPLORE_ENABLED=false",
      "GF_USERS_ALLOW_SIGN_UP=false",
      "GF_PATHS_PROVISIONING=/etc/grafana/provisioning",
    ]) {
      expect(dockerfile.includes(key), `Dockerfile misses ${key}`).toBe(true);
    }
  });
});
