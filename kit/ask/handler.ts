import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateText,
  isStepCount,
  streamText,
  toUIMessageStream,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import { ipCallerKey } from "../core/caller.js";
import type { McpConfig } from "../core/config.js";
import { isLocalHost } from "../core/dash.js";
import { vietnamDate } from "../core/date.js";
import type { Env } from "../core/env.js";
import type { AskTurnRow } from "../core/metrics.js";
import type { ToolContext } from "../core/tool.js";
import { askLimits, type AskConfig, type AskLocale } from "./config.js";
import { allowedOrigin, preflight, withCors } from "./cors.js";
import { cloudflareAskLogger, type AskLogger } from "./logger.js";
import { askInstructions, summaryInstructions } from "./prompt.js";
import { redact } from "./redact.js";
import { issueSession, verifySession } from "./session.js";
import { addCost, getConversation, getMessages, markLeadSent, todayCostUsd } from "./store.js";
import { buildAskTools, HANDOFF_TOOL, type AskToolRun } from "./tools.js";
import { verifyTurnstile } from "./turnstile.js";

/**
 * `/ask` and its sub-routes, mounted by `createWorker` only when `config.ask` is set.
 * Checks run cheapest first (contract in the kit README, "Ask"):
 * origin → method/size → session or Turnstile → per-IP rate limit → conversation
 * caps → daily budget → model call. Only the last user message is taken from the
 * request; history comes from D1, so a client cannot inject assistant turns.
 */

export type AskErrorCode =
  | "origin"
  | "bad_request"
  | "verify_failed"
  | "session_expired"
  | "rate_limited"
  | "conversation_limit"
  | "budget"
  | "upstream";

const STATUS: Record<AskErrorCode, number> = {
  origin: 403,
  bad_request: 400,
  verify_failed: 403,
  session_expired: 401,
  rate_limited: 429,
  conversation_limit: 429,
  budget: 503,
  upstream: 502,
};

export const ASK_PATHS = ["/ask", "/ask/summary", "/ask/lead"] as const;
export const MAX_BODY_BYTES = 64 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUMMARY_GAP_MS = 5 * 60 * 1000;
const BUDGET_CACHE_MS = 60 * 1000;

export interface AskDeps {
  /** The model for an OpenRouter id; tests pass a mock. */
  modelFor?: (id: string, ask: AskConfig, env: Env) => LanguageModel;
  fetcher?: typeof fetch;
  now?: () => number;
  logger?: AskLogger;
}

/** OpenRouter with the plan's settings: no providers that store prompts, cost in usage, fallbacks. */
export function openRouterModel(id: string, ask: AskConfig, env: Env): LanguageModel {
  const openrouter = createOpenRouter({ apiKey: env.OPENROUTER_API_KEY as string });
  return openrouter(id, {
    ...(ask.fallbackModels?.length ? { models: ask.fallbackModels } : {}),
    usage: { include: true },
    provider: { data_collection: "deny" },
  });
}

function errorResponse(code: AskErrorCode, origin: string | null, extra?: HeadersInit): Response {
  const res = Response.json({ code }, { status: STATUS[code], headers: extra });
  return origin ? withCors(res, origin) : res;
}

// Per isolate: spend cache for the daily budget, last summary time per conversation.
let budgetCache: { day: string; at: number; usd: number } | null = null;
const lastSummary = new Map<string, number>();

/** Test hook: forget the per-isolate caches. */
export function resetAskCaches(): void {
  budgetCache = null;
  lastSummary.clear();
}

/** Start of today in Vietnam (ms), matching the daily caller-key rotation. */
function vietnamDayStart(now: number): number {
  return Date.parse(`${vietnamDate(new Date(now))}T00:00:00+07:00`);
}

async function spentToday(db: D1Database, now: number): Promise<number> {
  const day = vietnamDate(new Date(now));
  if (budgetCache && budgetCache.day === day && now - budgetCache.at < BUDGET_CACHE_MS) return budgetCache.usd;
  const usd = await todayCostUsd(db, vietnamDayStart(now));
  budgetCache = { day, at: now, usd };
  return usd;
}

/** Adds spend to the cache right away so concurrent turns see it before the next refresh. */
function noteSpend(usd: number): void {
  if (budgetCache) budgetCache.usd += usd;
}

interface AskBody {
  id: string;
  text: string;
  locale: AskLocale;
  page: string;
  turnstileToken?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The text of the last user message in a `useChat` body. */
function lastUserText(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!isRecord(m) || m["role"] !== "user") continue;
    if (!Array.isArray(m["parts"])) return null;
    const text = m["parts"]
      .filter((p): p is { type: "text"; text: string } => isRecord(p) && p["type"] === "text" && typeof p["text"] === "string")
      .map((p) => p.text)
      .join("\n")
      .trim();
    return text || null;
  }
  return null;
}

async function readJson(request: Request): Promise<unknown | null> {
  const len = Number(request.headers.get("content-length") ?? "0");
  if (len > MAX_BODY_BYTES) return null;
  const raw = await request.text().catch(() => "");
  if (!raw || raw.length > MAX_BODY_BYTES) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseAskBody(raw: unknown, maxInputChars: number): AskBody | null {
  if (!isRecord(raw)) return null;
  const { id, locale, page, turnstileToken } = raw;
  if (typeof id !== "string" || !UUID_RE.test(id)) return null;
  if (locale !== "vi" && locale !== "en") return null;
  const text = lastUserText(raw["messages"]);
  if (!text || text.length > maxInputChars) return null;
  return {
    id: id.toLowerCase(),
    text,
    locale,
    page: typeof page === "string" ? page.slice(0, 300) : "",
    ...(typeof turnstileToken === "string" ? { turnstileToken } : {}),
  };
}

function stepCost(steps: readonly { providerMetadata?: unknown }[]): number {
  let usd = 0;
  for (const s of steps) {
    const cost = (s.providerMetadata as { openrouter?: { usage?: { cost?: unknown } } } | undefined)?.openrouter?.usage?.cost;
    if (typeof cost === "number" && Number.isFinite(cost)) usd += cost;
  }
  return usd;
}

/** Handles every Ask path. Returns null when `path` is not an Ask path. */
export async function handleAsk(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  config: McpConfig,
  log: (event: string, fields?: Record<string, unknown>) => void,
  deps: AskDeps = {},
): Promise<Response> {
  const ask = config.ask!;
  const url = new URL(request.url);
  const path = url.pathname;
  const now = deps.now ?? Date.now;
  const t0 = now();
  const limits = askLimits(ask);
  const logger = deps.logger ?? cloudflareAskLogger(env, log);
  const ip = request.headers.get("CF-Connecting-IP") ?? undefined;
  const country = (request as unknown as { cf?: { country?: string } }).cf?.country ?? "";
  const local = isLocalHost(url);

  // 1. Origin.
  if (request.method === "OPTIONS") return preflight(request, ask.allowedOrigins);
  const origin = allowedOrigin(request, ask.allowedOrigins);
  if (!origin) return errorResponse("origin", null, { vary: "Origin" });

  const callerKey = (await ipCallerKey(env.IP_HASH_SALT, ip).catch(() => null)) ?? "";
  const refuse = (code: AskErrorCode, headers?: HeadersInit): Response => {
    const row: AskTurnRow = {
      callerKey,
      slug: config.slug,
      status: code === "rate_limited" ? "rate_limited" : "error",
      code,
      country,
      latencyMs: now() - t0,
      toolCalls: 0,
      costMicroUsd: 0,
      tokensOut: 0,
    };
    logger.refusal(row);
    log("ask.refused", { path, code });
    return errorResponse(code, origin, headers);
  };

  // 2. Method and size.
  if (request.method !== "POST") return refuse("bad_request");
  const raw = await readJson(request);
  if (raw === null) return refuse("bad_request");

  if (path === "/ask/summary" || path === "/ask/lead") {
    return handleSideRoute(path, raw, request, env, ctx, config, deps, { origin, now, refuse, log });
  }

  const body = parseAskBody(raw, limits.maxInputChars);
  if (!body) return refuse("bad_request");

  // 3. Session, or Turnstile on the first turn.
  const secret = env.ASK_SESSION_SECRET as string | undefined;
  if (!secret) {
    log("ask.misconfigured", { missing: "ASK_SESSION_SECRET" });
    return refuse("upstream");
  }
  const session = await verifySession(secret, body.id, request.headers.get("x-ask-session"), now());
  if (session === "expired") return refuse("session_expired");
  if (session !== "ok") {
    const check = await verifyTurnstile({
      secret: env.TURNSTILE_SECRET as string | undefined,
      token: body.turnstileToken,
      allowedOrigins: ask.allowedOrigins,
      local,
      ...(ip ? { ip } : {}),
      ...(deps.fetcher ? { fetcher: deps.fetcher } : {}),
    });
    if (!check.ok) {
      log("ask.turnstile_failed", { reason: check.reason });
      return refuse("verify_failed");
    }
  }

  // 4. Per-IP rate limit (missing binding: allow, as in local dev).
  const limiter = env.ASK_RATE_LIMITER;
  if (limiter && callerKey) {
    const { success } = await limiter.limit({ key: callerKey });
    if (!success) return refuse("rate_limited", { "Retry-After": "60" });
  }

  // 5. Conversation caps.
  const db = env.ASK_DB;
  if (!db) {
    log("ask.misconfigured", { missing: "ASK_DB" });
    return refuse("upstream");
  }
  const existing = await getConversation(db, body.id);
  if (existing && (existing.turns >= limits.messagesPerConversation || existing.text_deleted_at !== null)) {
    return refuse("conversation_limit");
  }
  if (existing && existing.locale !== body.locale) return refuse("bad_request");

  // 6. Daily budget.
  if ((await spentToday(db, now())) >= limits.dailyBudgetUsd) return refuse("budget");
  if (!env.OPENROUTER_API_KEY && !deps.modelFor) {
    log("ask.misconfigured", { missing: "OPENROUTER_API_KEY" });
    return refuse("upstream");
  }

  // 7. The model call.
  const history: ModelMessage[] = existing
    ? (await getMessages(db, body.id)).map((m) => ({ role: m.role, content: m.text }) as ModelMessage)
    : [];
  const model = (deps.modelFor ?? openRouterModel)(ask.model, ask, env);
  const runs: AskToolRun[] = [];
  const cited: string[] = [];
  const toolCtx: ToolContext = { env, auth: null, requestId: crypto.randomUUID(), log };
  const userText = body.text;

  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      const tools = buildAskTools({
        config,
        ctx: toolCtx,
        locale: body.locale,
        metrics: { callerKey, country },
        onSource: (s) => {
          cited.push(s.url);
          writer.write({ type: "source-url", sourceId: s.url, url: s.url, title: s.title });
        },
        onTool: (r) => runs.push(r),
      });
      const result = streamText({
        model,
        instructions: askInstructions(ask, body.locale),
        messages: [...history, { role: "user", content: userText }],
        tools,
        stopWhen: isStepCount(limits.maxToolSteps),
        maxOutputTokens: limits.maxOutputTokens,
        maxRetries: 1,
        onEnd: (event) => {
          const costUsd = stepCost(event.steps);
          noteSpend(costUsd);
          const toolCalls = runs.filter((r) => r.name !== HANDOFF_TOOL).length;
          const handoff = runs.some((r) => r.name === HANDOFF_TOOL);
          const tokensIn = event.totalUsage.inputTokens ?? 0;
          const tokensOut = event.totalUsage.outputTokens ?? 0;
          ctx.waitUntil(
            logger.turn(
              {
                callerKey,
                slug: config.slug,
                status: "ok",
                code: "",
                country,
                latencyMs: now() - t0,
                toolCalls,
                costMicroUsd: Math.round(costUsd * 1_000_000),
                tokensOut,
              },
              {
                id: body.id,
                now: now(),
                locale: body.locale,
                page: body.page || null,
                country: country || null,
                callerKey: callerKey || null,
                model: event.response.modelId || ask.model,
                user: redact(userText),
                assistant: event.text,
                tools: runs,
                tokensIn,
                tokensOut,
                costUsd,
                cited,
              },
              handoff,
            ),
          );
        },
      });
      writer.merge(toUIMessageStream({ stream: result.stream }));
    },
    onError: (err) => {
      log("ask.upstream_error", { message: err instanceof Error ? err.message : String(err) });
      logger.refusal({
        callerKey,
        slug: config.slug,
        status: "error",
        code: "upstream",
        country,
        latencyMs: now() - t0,
        toolCalls: 0,
        costMicroUsd: 0,
        tokensOut: 0,
      });
      return "upstream";
    },
  });

  const token = await issueSession(secret, body.id, now());
  return withCors(createUIMessageStreamResponse({ stream, headers: { "x-ask-session": token } }), origin);
}

interface SideCtx {
  origin: string;
  now: () => number;
  refuse: (code: AskErrorCode, headers?: HeadersInit) => Response;
  log: (event: string, fields?: Record<string, unknown>) => void;
}

/** `/ask/summary` (model summary for the lead form) and `/ask/lead` (lead sent flag). Session only, no Turnstile. */
async function handleSideRoute(
  path: string,
  raw: unknown,
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  config: McpConfig,
  deps: AskDeps,
  side: SideCtx,
): Promise<Response> {
  const { origin, now, refuse, log } = side;
  const ask = config.ask!;
  const id = isRecord(raw) && typeof raw["id"] === "string" && UUID_RE.test(raw["id"]) ? raw["id"].toLowerCase() : null;
  if (!id) return refuse("bad_request");
  const secret = env.ASK_SESSION_SECRET as string | undefined;
  const session = await verifySession(secret, id, request.headers.get("x-ask-session"), now());
  if (session === "expired") return refuse("session_expired");
  if (session !== "ok") return refuse("verify_failed");
  const db = env.ASK_DB;
  if (!db) return refuse("upstream");
  const convo = await getConversation(db, id);
  if (!convo) return refuse("bad_request");

  if (path === "/ask/lead") {
    await markLeadSent(db, id);
    return withCors(Response.json({ ok: true }), origin);
  }

  const last = lastSummary.get(id);
  if (last !== undefined && now() - last < SUMMARY_GAP_MS) return refuse("rate_limited", { "Retry-After": "300" });
  if ((await spentToday(db, now())) >= askLimits(ask).dailyBudgetUsd) return refuse("budget");
  if (!env.OPENROUTER_API_KEY && !deps.modelFor) return refuse("upstream");
  lastSummary.set(id, now());

  const messages = await getMessages(db, id);
  const locale: AskLocale = convo.locale === "en" ? "en" : "vi";
  const transcript = messages.map((m) => `${m.role === "user" ? "Visitor" : "Assistant"}: ${m.text}`).join("\n");
  try {
    const result = await generateText({
      model: (deps.modelFor ?? openRouterModel)(ask.summaryModel ?? ask.model, ask, env),
      instructions: summaryInstructions(locale),
      prompt: transcript,
      maxOutputTokens: 200,
      maxRetries: 1,
    });
    const costUsd = stepCost(result.steps);
    noteSpend(costUsd);
    await addCost(db, id, costUsd).catch(() => undefined);
    return withCors(Response.json({ summary: result.text.trim() }), origin);
  } catch (err) {
    log("ask.summary_error", { message: err instanceof Error ? err.message : String(err) });
    return refuse("upstream");
  }
}
