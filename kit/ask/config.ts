/**
 * Ask: an optional chat endpoint (`/ask`) that answers visitors from the MCP's own
 * public tools through a model on OpenRouter. Switched on by an `ask` block in
 * `mcp.config.ts`; a clone without it serves no Ask routes (404).
 */

export type AskLocale = "vi" | "en";

export interface AskHandoffLink {
  label: string;
  href: string;
  /** Show only on this locale; both when omitted. */
  locale?: AskLocale;
}

export interface AskLimits {
  /** User messages per conversation (default 20). */
  messagesPerConversation?: number;
  /** Characters in one user message (default 1000). */
  maxInputChars?: number;
  /** Output tokens per answer (default 700). */
  maxOutputTokens?: number;
  /** Model steps per answer, tool calls included (default 4). */
  maxToolSteps?: number;
  /** Requests per IP per minute; enforced by the `ASK_RATE_LIMITER` binding's own limit (default 6). */
  perIpPerMinute?: number;
  /** Soft daily spend cap in USD across all conversations (default 3). */
  dailyBudgetUsd?: number;
}

export interface AskConfig {
  /** OpenRouter model id. */
  model: string;
  /** OpenRouter `models` fallback list, tried in order when `model` fails. */
  fallbackModels?: string[];
  /** Model for /ask/summary and topic labels; defaults to `model`. */
  summaryModel?: string;
  /** The client's own text (brand voice, facts), appended to the kit's behaviour rules. */
  systemPrompt: { vi: string; en: string } | string;
  /** Exact origins allowed to call /ask, e.g. ["https://example.com"]. Localhost is added only in local dev. */
  allowedOrigins: string[];
  /** Links the UI shows when the model suggests a handoff. */
  handoff: AskHandoffLink[];
  /** Fixed label set for topic tagging; "other" is always added. */
  topics: string[];
  /** Days before conversation text is deleted (default 90). */
  retentionDays?: number;
  /** Hours a session token stays valid after the last answer (default 24). After that the
   * next turn needs a new Turnstile token; the conversation itself carries on. */
  sessionHours?: number;
  limits?: AskLimits;
}

export const ASK_DEFAULTS = {
  retentionDays: 90,
  sessionHours: 24,
  messagesPerConversation: 20,
  maxInputChars: 1000,
  maxOutputTokens: 700,
  maxToolSteps: 4,
  perIpPerMinute: 6,
  dailyBudgetUsd: 3,
} as const;

export type ResolvedAskLimits = Required<AskLimits>;

/** The limits with defaults filled in. */
export function askLimits(ask: AskConfig): ResolvedAskLimits {
  const l = ask.limits ?? {};
  return {
    messagesPerConversation: l.messagesPerConversation ?? ASK_DEFAULTS.messagesPerConversation,
    maxInputChars: l.maxInputChars ?? ASK_DEFAULTS.maxInputChars,
    maxOutputTokens: l.maxOutputTokens ?? ASK_DEFAULTS.maxOutputTokens,
    maxToolSteps: l.maxToolSteps ?? ASK_DEFAULTS.maxToolSteps,
    perIpPerMinute: l.perIpPerMinute ?? ASK_DEFAULTS.perIpPerMinute,
    dailyBudgetUsd: l.dailyBudgetUsd ?? ASK_DEFAULTS.dailyBudgetUsd,
  };
}

/** The topic list the tagger may answer with: the config's plus "other". */
export function askTopics(ask: AskConfig): string[] {
  return ask.topics.includes("other") ? [...ask.topics] : [...ask.topics, "other"];
}

const LOCAL_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;
const HTTPS_ORIGIN_RE = /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/;

/** Throws with a message naming the problem. Called by `defineConfig`. */
export function validateAskConfig(ask: AskConfig): void {
  if (typeof ask.model !== "string" || ask.model.trim() === "") throw new Error("ask.model must be a non-empty string");
  for (const m of ask.fallbackModels ?? []) {
    if (typeof m !== "string" || m.trim() === "") throw new Error("ask.fallbackModels entries must be non-empty strings");
  }
  if (ask.summaryModel !== undefined && ask.summaryModel.trim() === "") throw new Error("ask.summaryModel must be non-empty when set");
  const prompts = typeof ask.systemPrompt === "string" ? [ask.systemPrompt] : [ask.systemPrompt?.vi, ask.systemPrompt?.en];
  if (prompts.some((p) => typeof p !== "string")) throw new Error("ask.systemPrompt must be a string or { vi, en }");
  if (!Array.isArray(ask.allowedOrigins) || ask.allowedOrigins.length === 0) {
    throw new Error("ask.allowedOrigins must list at least one origin");
  }
  for (const o of ask.allowedOrigins) {
    if (!HTTPS_ORIGIN_RE.test(o) && !LOCAL_ORIGIN_RE.test(o)) {
      throw new Error(`ask.allowedOrigins: "${o}" must be an exact https:// origin (or http://localhost:<port>), no path`);
    }
  }
  if (!Array.isArray(ask.topics) || ask.topics.length === 0) throw new Error("ask.topics must not be empty");
  if (new Set(ask.topics).size !== ask.topics.length) throw new Error("ask.topics must be unique");
  for (const t of ask.topics) {
    if (!/^[a-z0-9-]+$/.test(t)) throw new Error(`ask.topics: "${t}" must be [a-z0-9-]`);
  }
  for (const h of ask.handoff ?? []) {
    if (!h.label || !h.href) throw new Error("ask.handoff entries need label and href");
    if (h.locale !== undefined && h.locale !== "vi" && h.locale !== "en") throw new Error(`ask.handoff: bad locale "${h.locale}"`);
  }
  const positive = (name: string, v: number | undefined) => {
    if (v !== undefined && !(typeof v === "number" && Number.isFinite(v) && v > 0)) {
      throw new Error(`ask.${name} must be a positive number`);
    }
  };
  positive("retentionDays", ask.retentionDays);
  positive("sessionHours", ask.sessionHours);
  for (const [k, v] of Object.entries(ask.limits ?? {})) positive(`limits.${k}`, v as number | undefined);
}

/** The client prompt for a locale. */
export function clientPromptFor(ask: AskConfig, locale: AskLocale): string {
  return typeof ask.systemPrompt === "string" ? ask.systemPrompt : ask.systemPrompt[locale];
}
