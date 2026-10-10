import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { McpConfig } from "../core/config.js";
import { recordToolCall } from "../core/metrics.js";
import { ToolError, type ToolContext, type ToolDef } from "../core/tool.js";
import type { AskLocale } from "./config.js";

/** The Ask-only tool the model calls to offer a handoff to a person. */
export const HANDOFF_TOOL = "suggest_handoff";

export const MAX_SOURCES = 4;

export interface AskSource {
  url: string;
  title: string;
}

export interface AskToolRun {
  name: string;
  slug?: string;
}

export interface AskToolsOptions {
  config: McpConfig;
  ctx: ToolContext;
  locale: AskLocale;
  /** Facts for the per-call metrics row. */
  metrics: { callerKey: string; country: string };
  /** Called once per new source (deduplicated by url, at most MAX_SOURCES). */
  onSource?: (source: AskSource) => void;
  /** Called after every tool run, the handoff included. */
  onTool?: (run: AskToolRun) => void;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Every `{ url, title }` pair in a tool result, in order, http(s) urls only. Walks
 * nested objects and arrays (search results, single items), a bounded number of nodes.
 */
export function sourcesIn(data: unknown, limit = 50): AskSource[] {
  const out: AskSource[] = [];
  const stack: unknown[] = [data];
  let seen = 0;
  while (stack.length > 0 && seen < 500 && out.length < limit) {
    const node = stack.shift();
    seen++;
    if (Array.isArray(node)) {
      stack.push(...node);
    } else if (isRecord(node)) {
      const { url, title } = node;
      if (typeof url === "string" && /^https?:\/\//.test(url) && typeof title === "string" && title.trim()) {
        out.push({ url, title: title.trim() });
      }
      for (const v of Object.values(node)) if (typeof v === "object" && v !== null) stack.push(v);
    }
  }
  return out;
}

/** The first `slug` string in a tool result, for the stored tool list. */
function slugIn(data: unknown): string | undefined {
  if (isRecord(data) && typeof data["slug"] === "string") return data["slug"];
  if (isRecord(data) && isRecord(data["item"]) && typeof data["item"]["slug"] === "string") return data["item"]["slug"];
  return undefined;
}

/** Tools offered to Ask: the config's public tools only. Visitors are anonymous. */
export function askToolDefs(config: McpConfig): ToolDef[] {
  return config.tools.filter((t) => t.access === "public");
}

/**
 * The AI SDK tool set for one Ask turn: each public `ToolDef` run in process with an
 * anonymous `ToolContext`, plus `suggest_handoff`. A tool input named `locale` is
 * hidden from the model and set to the visitor's locale.
 */
export function buildAskTools(opts: AskToolsOptions): ToolSet {
  const { config, ctx, locale, metrics, onSource, onTool } = opts;
  const sourceUrls = new Set<string>();
  const anonCtx: ToolContext = { ...ctx, auth: null };
  const tools: ToolSet = {};

  for (const def of askToolDefs(config)) {
    const shape = def.inputSchema.shape as Record<string, unknown>;
    const hasLocale = "locale" in shape;
    const modelSchema = hasLocale ? def.inputSchema.omit({ locale: true }) : def.inputSchema;
    tools[def.name] = tool({
      description: def.description,
      inputSchema: modelSchema,
      execute: async (input: Record<string, unknown>) => {
        const t0 = Date.now();
        const args = def.inputSchema.parse(hasLocale ? { ...input, locale } : input);
        let status: "ok" | "error" | "invalid_input" = "ok";
        let code = "";
        let count = -1;
        try {
          const result = await def.execute(args, anonCtx);
          count = result.count ?? -1;
          for (const s of sourcesIn(result.data)) {
            if (sourceUrls.has(s.url) || sourceUrls.size >= MAX_SOURCES) continue;
            sourceUrls.add(s.url);
            onSource?.(s);
          }
          const slug = slugIn(result.data);
          onTool?.({ name: def.name, ...(slug ? { slug } : {}) });
          return result.data;
        } catch (err) {
          if (err instanceof ToolError) {
            status = err.code === "bad_input" ? "invalid_input" : "error";
            code = err.code;
            onTool?.({ name: def.name });
            return { error: err.message };
          }
          status = "error";
          code = "internal";
          ctx.log("ask.tool_internal_error", { tool: def.name, stack: err instanceof Error ? err.stack : String(err) });
          onTool?.({ name: def.name });
          return { error: "Internal error" };
        } finally {
          recordToolCall(ctx.env, {
            callerKey: metrics.callerKey,
            slug: config.slug,
            tool: def.name,
            status,
            code,
            client: "ask",
            access: "public",
            auth: "anon",
            country: metrics.country,
            era: "modern",
            latencyMs: Date.now() - t0,
            count,
            bytes: -1,
          });
        }
      },
    });
  }

  tools[HANDOFF_TOOL] = tool({
    description:
      "Offer the visitor a way to reach a person: call when they want to start a project, ask for a quote, " +
      "or when the content does not answer their question. The interface shows contact options; do not list them yourself.",
    inputSchema: z.object({ reason: z.string().max(200).optional() }),
    execute: async () => {
      onTool?.({ name: HANDOFF_TOOL });
      return { shown: true };
    },
  });

  return tools;
}
