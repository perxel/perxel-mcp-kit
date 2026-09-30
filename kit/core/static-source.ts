import { sha256Hex } from "./caller.js";
import type { Env } from "./env.js";
import { ToolError } from "./tool.js";
import type { SourceStatus } from "./worker.js";

export interface StaticSourceOptions<T> {
  /** Source name, shown in /health (e.g. "content"). */
  name: string;
  /** Where to fetch the JSON file from. */
  url: (env: Env) => string;
  /** Key in CONTENT_KV holding the last good copy. */
  kvKey: string;
  /** Fresh-memory window in ms (default 600_000, about 10 minutes). */
  maxAgeMs?: number;
  /** Validate the JSON shape with zod; throw on a bad shape. */
  parse: (json: unknown) => T;
  /** Item count for /health (default: the length of an `items` array). */
  count?: (data: T) => number;
}

export interface StaticSource<T> {
  get(env: Env, ctx?: ExecutionContext): Promise<T>;
  status(): SourceStatus;
}

interface Memory<T> {
  data: T;
  etag: string;
  hash: string;
  fetchedAt: number;
}

/** The last good copy as stored in KV. */
interface StoredCopy {
  etag: string;
  hash: string;
  fetchedAt: string;
  body: string;
}

const UNAVAILABLE = "Content is not available yet";

function defaultCount(data: unknown): number {
  if (typeof data === "object" && data !== null) {
    const items = (data as { items?: unknown }).items;
    if (Array.isArray(items)) return items.length;
  }
  return 0;
}

/**
 * A static JSON data source with the plan's loading order: fresh memory →
 * conditional fetch (`If-None-Match`; 304 keeps memory and bumps fetchedAt) →
 * on 200 parse, keep in memory, write KV only when the ETag or the SHA-256
 * of the body changed → on fetch/parse failure use stale memory, else KV →
 * else throw `ToolError("unavailable", ...)`. Concurrent calls share one
 * in-flight fetch. KV writes are awaited (they only happen when content
 * changed), so every caller sees a consistent state.
 */
export function createStaticSource<T>(opts: StaticSourceOptions<T>): StaticSource<T> {
  const maxAgeMs = opts.maxAgeMs ?? 600_000;
  const count = opts.count ?? defaultCount;
  let memory: Memory<T> | null = null;
  let inFlight: Promise<T> | null = null;
  let current: SourceStatus = { from: "empty", fetchedAt: "", etag: "", items: 0 };

  function setCurrent(from: SourceStatus["from"], mem: Memory<T>): void {
    current = { from, fetchedAt: new Date(mem.fetchedAt).toISOString(), etag: mem.etag, items: count(mem.data) };
  }

  async function readKv(env: Env): Promise<StoredCopy | null> {
    let raw: string | null;
    try {
      raw = await env.CONTENT_KV?.get(opts.kvKey, "text");
    } catch {
      return null; // missing binding or KV failure: no fallback copy
    }
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<StoredCopy>;
      if (typeof parsed.body !== "string") return null;
      return {
        etag: typeof parsed.etag === "string" ? parsed.etag : "",
        hash: typeof parsed.hash === "string" ? parsed.hash : "",
        fetchedAt: typeof parsed.fetchedAt === "string" ? parsed.fetchedAt : "",
        body: parsed.body,
      };
    } catch {
      return null;
    }
  }

  function useKv(stored: StoredCopy): T {
    let data: T;
    try {
      data = opts.parse(JSON.parse(stored.body));
    } catch {
      throw new ToolError("unavailable", `${opts.name}: ${UNAVAILABLE}`);
    }
    memory = {
      data,
      etag: stored.etag,
      hash: stored.hash,
      fetchedAt: Date.parse(stored.fetchedAt) || Date.now(),
    };
    setCurrent("kv-fallback", memory);
    return data;
  }

  function fallback(stored: StoredCopy | null): T {
    if (memory) {
      setCurrent("memory", memory); // stale but present; fetchedAt shows its age
      return memory.data;
    }
    if (stored) return useKv(stored);
    throw new ToolError("unavailable", `${opts.name}: ${UNAVAILABLE}`);
  }

  async function load(env: Env): Promise<T> {
    const now = Date.now();
    const stored = await readKv(env);
    const etag = memory?.etag ?? stored?.etag ?? "";
    let res: Response;
    try {
      res = await fetch(opts.url(env), etag ? { headers: { "If-None-Match": etag } } : undefined);
    } catch {
      return fallback(stored);
    }
    if (res.status === 304) {
      if (memory) {
        memory.fetchedAt = now;
        setCurrent("memory", memory);
        return memory.data;
      }
      // No memory but our (KV) ETag still matches: serve the KV copy.
      if (stored) return useKv(stored);
      throw new ToolError("unavailable", `${opts.name}: ${UNAVAILABLE}`);
    }
    if (res.status !== 200) return fallback(stored);
    let body: string;
    try {
      body = await res.text();
    } catch {
      return fallback(stored);
    }
    let data: T;
    try {
      data = opts.parse(JSON.parse(body));
    } catch {
      return fallback(stored);
    }
    const resEtag = res.headers.get("etag") ?? "";
    const hash = await sha256Hex(body);
    const prev = memory ?? stored;
    memory = { data, etag: resEtag, hash, fetchedAt: now };
    setCurrent("fetch", memory);
    // Write KV only when the content changed (the hash covers ETag-less servers).
    if (!prev || prev.etag !== resEtag || prev.hash !== hash) {
      const copy: StoredCopy = { etag: resEtag, hash, fetchedAt: new Date(now).toISOString(), body };
      try {
        await env.CONTENT_KV?.put(opts.kvKey, JSON.stringify(copy));
      } catch {
        // A failed backup write must not fail the request.
      }
    }
    return data;
  }

  async function get(env: Env, _ctx?: ExecutionContext): Promise<T> {
    const now = Date.now();
    if (memory && now - memory.fetchedAt < maxAgeMs) {
      setCurrent("memory", memory);
      return memory.data;
    }
    if (!inFlight) {
      const pending = load(env);
      inFlight = pending;
      pending.then(
        () => {
          if (inFlight === pending) inFlight = null;
        },
        () => {
          if (inFlight === pending) inFlight = null;
        },
      );
    }
    return inFlight;
  }

  function status(): SourceStatus {
    return { ...current };
  }

  return { get, status };
}
