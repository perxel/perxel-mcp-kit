import { foldText } from "./fold-text.js";

/** One item of a static JSON source (the recommended shape, see STANDARD.md). */
export interface StaticItem {
  type: string;
  slug: string;
  title: string;
  excerpt: string;
  url: string;
  category: string;
  date: string | null;
  tags: string[];
  body: string;
}

/** A list/search result: everything except the full text (token rules). */
export type CompactItem = Omit<StaticItem, "body">;

/** Strip the full text: list and search tools return compact items only. */
export function toCompact(item: StaticItem): CompactItem {
  const { body: _body, ...rest } = item;
  return rest;
}

/**
 * Clamp a list `limit`: non-numbers, NaN, and values below 1 fall back to
 * `def`; anything above `max` is capped. Floats are floored.
 */
export function clampLimit(n: unknown, def = 5, max = 20): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 1) return def;
  return Math.min(Math.floor(n), max);
}

export interface SearchOptions {
  /** Fields to match against (default: title, excerpt, category, tags, body). */
  fields?: (keyof StaticItem)[];
  limit?: number;
}

const DEFAULT_FIELDS: (keyof StaticItem)[] = ["title", "excerpt", "category", "tags", "body"];

/** Title matches outrank everything else; body matches rank last. */
const WEIGHTS: Record<string, number> = { title: 10, excerpt: 4, category: 3, tags: 3, body: 1 };

function fieldText(item: StaticItem, field: keyof StaticItem): string {
  const value = item[field];
  if (value === null || value === undefined) return "";
  return Array.isArray(value) ? value.join(" ") : String(value);
}

/**
 * Diacritic-insensitive search over static items (foldText on both sides).
 * Every query token must appear in at least one searched field; items score
 * the best field weight per token (title above body) and sort highest first.
 * A blank query lists the first `limit` items. Results are compact (no body).
 */
export function searchItems(items: StaticItem[], query: string, opts: SearchOptions = {}): CompactItem[] {
  const limit = clampLimit(opts.limit);
  const fields = opts.fields ?? DEFAULT_FIELDS;
  const tokens = foldText(query).split(" ").filter((t) => t.length > 0);
  if (tokens.length === 0) return items.slice(0, limit).map(toCompact);

  const folded = new Map<string, string>();
  const textFor = (index: number, item: StaticItem, field: keyof StaticItem): string => {
    const key = `${index}:${field}`;
    let text = folded.get(key);
    if (text === undefined) {
      text = foldText(fieldText(item, field));
      folded.set(key, text);
    }
    return text;
  };
  const scored: { item: StaticItem; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    let score = 0;
    for (const token of tokens) {
      let best = 0;
      for (const field of fields) {
        if (textFor(index, item, field).includes(token)) best = Math.max(best, WEIGHTS[field] ?? 2);
      }
      if (best === 0) return; // this token matches nowhere: not a hit
      score += best;
    }
    scored.push({ item, score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, limit).map((s) => toCompact(s.item));
}

/** Detail lookup: the full item (with body) for one slug, or undefined. */
export function bySlug(items: StaticItem[], slug: string): StaticItem | undefined {
  return items.find((item) => item.slug === slug);
}

export interface PassageOptions {
  /** Passages to return (default 2). */
  max?: number;
  /** Characters per passage, roughly (default 400). */
  chars?: number;
}

/** True when a folded token starts a word of the folded text. */
function hasWord(foldedText: string, token: string): boolean {
  return ` ${foldedText}`.includes(` ${token}`);
}

/**
 * The paragraphs of a full text that best match a query, for search results that
 * can answer a question on their own (Ask then needs no detail call). Paragraphs are
 * split on blank lines; a short heading is kept in front of the paragraph under it.
 * Each paragraph scores the number of distinct query words it contains (diacritics
 * ignored); the best `max` with at least one come back in page order, cut to about
 * `chars` from the first sentence that matches.
 */
export function passages(body: string, query: string, opts: PassageOptions = {}): string[] {
  const max = opts.max ?? 2;
  const chars = opts.chars ?? 400;
  const tokens = [...new Set(foldText(query).split(" ").filter((t) => t.length >= 2))];
  if (tokens.length === 0 || !body) return [];

  const paras: string[] = [];
  let heading = "";
  for (const raw of body.split(/\n\s*\n/)) {
    const p = raw.replace(/\s+/g, " ").trim();
    if (!p) continue;
    if (p.length < 80 && !/[.!?:;]$/.test(p)) {
      heading = p; // a heading: carried onto the next paragraph
      continue;
    }
    paras.push(heading ? `${heading}: ${p}` : p);
    heading = "";
  }

  const scored = paras
    .map((text, index) => {
      const folded = foldText(text);
      return { text, index, score: tokens.filter((t) => hasWord(folded, t)).length };
    })
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, max)
    .sort((a, b) => a.index - b.index);

  return scored.map(({ text }) => {
    if (text.length <= chars) return text;
    const sentences = text.split(/(?<=[.!?])\s+/);
    const start = Math.max(0, sentences.findIndex((s) => tokens.some((t) => hasWord(foldText(s), t))));
    let out = "";
    for (const s of sentences.slice(start)) {
      if (out && out.length + s.length + 1 > chars) break;
      out = out ? `${out} ${s}` : s;
    }
    if (out.length > chars) out = `${out.slice(0, chars).replace(/\s+\S*$/, "")}…`;
    else if (start + out.split(/(?<=[.!?])\s+/).length < sentences.length) out = `${out} …`;
    return start > 0 ? `… ${out}` : out;
  });
}
