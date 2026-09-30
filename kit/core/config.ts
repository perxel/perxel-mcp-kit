import type { ToolDef } from "./tool.js";

export interface McpConfig {
  slug: string; // [a-z0-9-]+, used for dataset name and dashboard path
  name: string;
  version: string;
  description: string;
  scopes: Record<string, string>; // every private tool's scope must be listed
  tools: ToolDef[];
  docs: { contact: string };
}

const SLUG_RE = /^[a-z0-9-]+$/;

/**
 * Validates a clone config at startup (and in tests): slug format, unique tool
 * names, and every private tool declaring a scope listed in `scopes`.
 * Throws with a message naming the problem.
 */
export function defineConfig(config: McpConfig): McpConfig {
  if (!SLUG_RE.test(config.slug)) {
    throw new Error(`invalid slug "${config.slug}": use [a-z0-9-]`);
  }
  const seen = new Set<string>();
  for (const tool of config.tools) {
    if (seen.has(tool.name)) {
      throw new Error(`duplicate tool name "${tool.name}"`);
    }
    seen.add(tool.name);
    if (tool.access === "private") {
      if (!tool.scope) {
        throw new Error(`private tool "${tool.name}" must declare a scope`);
      }
      if (!(tool.scope in config.scopes)) {
        throw new Error(`private tool "${tool.name}" scope "${tool.scope}" is not listed in config.scopes`);
      }
    }
  }
  return config;
}
