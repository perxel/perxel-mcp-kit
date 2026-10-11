import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { McpConfig } from "../core/config.js";
import { recordToolCall } from "../core/metrics.js";
import { ToolError, type ToolContext, type ToolDef } from "../core/tool.js";
import type { AskAction, AskLocale } from "./config.js";

/** The Ask-only tool the model calls to offer a handoff to a person. */
export const HANDOFF_TOOL = "suggest_handoff";
/** Action tools: they prepare a form for the visitor and send nothing (`ask.actions`). */
export const LEAD_TOOL = "prepare_lead";
export const SUBSCRIBE_TOOL = "prepare_subscribe";
export const ACTION_TOOLS: Record<AskAction, string> = { lead: LEAD_TOOL, subscribe: SUBSCRIBE_TOOL };
/** Ask-only tools that are not content lookups (left out of the turn's tool count). */
export const UI_TOOLS: readonly string[] = [HANDOFF_TOOL, LEAD_TOOL, SUBSCRIBE_TOOL];

export const MAX_SOURCES = 4;
/** Sources taken from one tool result: the top hits, not a whole search list. */
export const SOURCES_PER_RESULT = 2;

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
  /** Action tools to offer (`ask.actions`); none when omitted. */
  actions?: readonly AskAction[];
  /** The visitor's current message, raw: action fields not written in it are dropped. */
  userText?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Whether `value` is written in the visitor's message: an email or link as text
 * (case-insensitive), a phone number by its digits (8 or more), anything else as text.
 * Guards the action tools against fields the model made up or took from elsewhere.
 */
export function writtenIn(value: string, message: string): boolean {
  const v = value.trim().toLowerCase().replace(/\/+$/, "");
  if (!v) return false;
  const m = message.toLowerCase();
  if (!v.includes("@") && /^[+\d\s().-]+$/.test(v)) {
    const digits = v.replace(/\D/g, "");
    return digits.length >= 8 && m.replace(/\D/g, "").includes(digits);
  }
  return m.includes(v);
}

const LeadInput = z.object({
  intent: z.enum(["contact", "quote", "other"]).describe("contact: wants to be contacted; quote: wants a price or a proposal; other: anything else."),
  message: z.string().max(500).describe("What the visitor wants, in one or two sentences, in their language."),
  contact: z.string().max(200).optional().describe("Phone or email exactly as the visitor wrote it in this message."),
  name: z.string().max(100).optional().describe("The visitor's own name, only if they wrote it."),
  briefUrl: z.string().max(500).optional().describe("A link to their brief, exactly as written (http or https)."),
});

const SubscribeInput = z.object({
  email: z.string().max(200).optional().describe("The visitor's email exactly as they wrote it in this message."),
});

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
      if (typeof url === "string" && /^https?:\/\//.test(url) && typeof title === "string" && title.trim() && !out.some((o) => o.url === url)) {
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
  const { config, ctx, locale, metrics, onSource, onTool, actions = [] } = opts;
  const said = opts.userText ?? "";
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
          for (const s of sourcesIn(result.data, SOURCES_PER_RESULT)) {
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

  if (actions.includes("lead")) {
    tools[LEAD_TOOL] = tool({
      description:
        "Prepare a contact request for the visitor to check and send: call only when the visitor asks to be contacted or " +
        "quoted. Sends nothing; the interface shows a form with these details. Fill only what the visitor wrote.",
      inputSchema: LeadInput,
      execute: async (input) => {
        onTool?.({ name: LEAD_TOOL });
        const keep = (v: string | undefined) => (v && writtenIn(v, said) ? v.trim() : undefined);
        const briefUrl = keep(input.briefUrl);
        return {
          action: "lead" as const,
          intent: input.intent,
          message: input.message.trim(),
          ...(keep(input.contact) ? { contact: keep(input.contact) } : {}),
          ...(keep(input.name) ? { name: keep(input.name) } : {}),
          ...(briefUrl && /^https?:\/\//i.test(briefUrl) ? { briefUrl } : {}),
        };
      },
    });
  }

  if (actions.includes("subscribe")) {
    tools[SUBSCRIBE_TOOL] = tool({
      description:
        "Prepare a newsletter signup for the visitor to check and send: call only when the visitor asks for updates, " +
        "new posts by email or the newsletter. Sends nothing; the interface shows a form.",
      inputSchema: SubscribeInput,
      execute: async (input) => {
        onTool?.({ name: SUBSCRIBE_TOOL });
        const email = input.email?.trim();
        return { action: "subscribe" as const, ...(email && EMAIL_RE.test(email) && writtenIn(email, said) ? { email } : {}) };
      },
    });
  }

  return tools;
}
