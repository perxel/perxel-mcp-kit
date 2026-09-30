import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { sha256Hex } from "./caller.js";
import type { Env } from "./env.js";
import { createStaticSource } from "./static-source.js";
import { ToolError } from "./tool.js";

const Doc = z.object({
  version: z.number(),
  items: z.array(z.object({ slug: z.string(), title: z.string() })),
});
type Doc = z.infer<typeof Doc>;

const BODY = JSON.stringify({
  version: 1,
  items: [
    { slug: "a", title: "A" },
    { slug: "b", title: "B" },
  ],
});
const BODY_CHANGED = JSON.stringify({ version: 2, items: [{ slug: "a", title: "A2" }] });

interface FetchCall {
  url: string;
  ifNoneMatch: string | null;
}

let fetchCalls: FetchCall[] = [];
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(handler: (url: string, ifNoneMatch: string | null) => Response | Promise<Response>): void {
  fetchCalls = [];
  globalThis.fetch = (async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const [input, init] = args;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const ifNoneMatch = new Headers(init?.headers).get("if-none-match");
    fetchCalls.push({ url, ifNoneMatch });
    return handler(url, ifNoneMatch);
  }) as typeof fetch;
}

interface FakeKv {
  store: Map<string, string>;
  puts: { key: string; value: string }[];
  kv: KVNamespace;
}

function fakeKv(initial: Record<string, string> = {}): FakeKv {
  const store = new Map(Object.entries(initial));
  const puts: { key: string; value: string }[] = [];
  const kv = {
    get: async (key: string) => (store.has(key) ? store.get(key)! : null),
    put: async (key: string, value: string) => {
      puts.push({ key, value });
      store.set(key, value);
    },
  } as unknown as KVNamespace;
  return { store, puts, kv };
}

function testEnv(kv: KVNamespace): Env {
  return { CONTENT_URL: "https://example.com/content.json", CONTENT_KV: kv } as unknown as Env;
}

function ok(body: string, etag: string): Response {
  return new Response(body, { status: 200, headers: { etag } });
}

/** A KV last-good copy in the stored shape. */
function storedCopy(body: string, etag: string, hash: string): string {
  return JSON.stringify({ etag, hash, fetchedAt: "2026-09-30T00:00:00.000Z", body });
}

describe("static source", () => {
  it("starts empty", () => {
    const src = createStaticSource<Doc>({ name: "c", url: () => "", kvKey: "k", parse: (j) => Doc.parse(j) });
    expect(src.status()).toEqual({ from: "empty", fetchedAt: "", etag: "", items: 0 });
  });

  it("loads via fetch, writes KV, and reports fetch", async () => {
    const { puts, kv } = fakeKv();
    stubFetch(() => ok(BODY, '"a"'));
    const src = createStaticSource<Doc>({
      name: "content",
      url: (env) => env.CONTENT_URL as string,
      kvKey: "content",
      parse: (j) => Doc.parse(j),
    });
    const data = await src.get(testEnv(kv));
    expect(data.items.map((i) => i.slug)).toEqual(["a", "b"]);
    const status = src.status();
    expect(status.from).toBe("fetch");
    expect(status.etag).toBe('"a"');
    expect(status.items).toBe(2);
    expect(status.fetchedAt.length).toBeGreaterThan(0);
    expect(puts).toHaveLength(1);
    expect(JSON.parse(puts[0].value).body).toBe(BODY);
    expect(fetchCalls[0].url).toBe("https://example.com/content.json");
  });

  it("serves fresh memory without fetching again", async () => {
    const { kv } = fakeKv();
    stubFetch(() => ok(BODY, '"a"'));
    const src = createStaticSource<Doc>({ name: "c", url: () => "https://x/y", kvKey: "k", parse: (j) => Doc.parse(j) });
    await src.get(testEnv(kv));
    await src.get(testEnv(kv));
    expect(fetchCalls).toHaveLength(1);
    expect(src.status().from).toBe("memory");
  });

  it("revalidates with If-None-Match; 304 keeps memory and bumps fetchedAt", async () => {
    const { puts, kv } = fakeKv();
    const src = createStaticSource<Doc>({
      name: "c",
      url: () => "https://x/y",
      kvKey: "k",
      maxAgeMs: 0, // every get revalidates
      parse: (j) => Doc.parse(j),
    });
    stubFetch(() => ok(BODY, '"a"'));
    await src.get(testEnv(kv));
    const first = src.status().fetchedAt;
    stubFetch((_url, ifNoneMatch) => {
      expect(ifNoneMatch).toBe('"a"');
      return new Response(null, { status: 304 });
    });
    const data = await src.get(testEnv(kv));
    expect(data.items).toHaveLength(2);
    expect(src.status().from).toBe("memory");
    expect(src.status().fetchedAt >= first).toBe(true);
    expect(puts).toHaveLength(1); // no KV rewrite on 304
  });

  it("writes KV only when the content changes", async () => {
    const hash = await sha256Hex(BODY);
    const { puts, kv } = fakeKv({ content: storedCopy(BODY, '"a"', hash) });
    const src = createStaticSource<Doc>({
      name: "c",
      url: () => "https://x/y",
      kvKey: "content",
      maxAgeMs: 0,
      parse: (j) => Doc.parse(j),
    });
    stubFetch(() => ok(BODY, '"a"'));
    await src.get(testEnv(kv));
    expect(puts).toHaveLength(0); // same ETag and hash: no write
    stubFetch(() => ok(BODY_CHANGED, '"a"')); // same ETag, different body
    await src.get(testEnv(kv));
    expect(puts).toHaveLength(1);
    expect(JSON.parse(puts[0].value).body).toBe(BODY_CHANGED);
  });

  it("falls back to stale memory when the fetch fails", async () => {
    const { kv } = fakeKv();
    const src = createStaticSource<Doc>({
      name: "c",
      url: () => "https://x/y",
      kvKey: "k",
      maxAgeMs: 0,
      parse: (j) => Doc.parse(j),
    });
    stubFetch(() => ok(BODY, '"a"'));
    await src.get(testEnv(kv));
    stubFetch(() => {
      throw new Error("network down");
    });
    const data = await src.get(testEnv(kv));
    expect(data.items).toHaveLength(2);
    expect(src.status().from).toBe("memory");
  });

  it("falls back to KV when memory is empty", async () => {
    const { kv } = fakeKv({ content: storedCopy(BODY, '"a"', "old-hash") });
    stubFetch(() => {
      throw new Error("network down");
    });
    const src = createStaticSource<Doc>({ name: "c", url: () => "https://x/y", kvKey: "content", parse: (j) => Doc.parse(j) });
    const data = await src.get(testEnv(kv));
    expect(data.items.map((i) => i.slug)).toEqual(["a", "b"]);
    expect(src.status()).toMatchObject({ from: "kv-fallback", etag: '"a"', items: 2 });
  });

  it("serves the KV copy on a 304 with no memory", async () => {
    const { kv } = fakeKv({ content: storedCopy(BODY, '"a"', "old-hash") });
    stubFetch((_url, ifNoneMatch) => {
      expect(ifNoneMatch).toBe('"a"'); // the KV ETag still revalidates
      return new Response(null, { status: 304 });
    });
    const src = createStaticSource<Doc>({ name: "c", url: () => "https://x/y", kvKey: "content", parse: (j) => Doc.parse(j) });
    const data = await src.get(testEnv(kv));
    expect(data.items).toHaveLength(2);
    expect(src.status().from).toBe("kv-fallback");
  });

  it("throws unavailable when memory, fetch and KV all fail", async () => {
    const src = createStaticSource<Doc>({ name: "c", url: () => "https://x/y", kvKey: "k", parse: (j) => Doc.parse(j) });
    const { kv } = fakeKv();
    stubFetch(() => {
      throw new Error("network down");
    });
    await expect(src.get(testEnv(kv))).rejects.toMatchObject({ code: "unavailable" });
    stubFetch(() => new Response("oops", { status: 500 }));
    await expect(src.get(testEnv(kv))).rejects.toBeInstanceOf(ToolError);
    stubFetch(() => ok("not json{", '"b"'));
    await expect(src.get(testEnv(kv))).rejects.toMatchObject({ code: "unavailable" });
    stubFetch(() => ok(JSON.stringify({ wrong: "shape" }), '"c"'));
    await expect(src.get(testEnv(kv))).rejects.toMatchObject({ code: "unavailable" });
    stubFetch(() => new Response(null, { status: 304 })); // nothing cached to keep
    await expect(src.get(testEnv(kv))).rejects.toMatchObject({ code: "unavailable" });
  });

  it("shares one in-flight fetch between concurrent calls", async () => {
    const { kv } = fakeKv();
    let release!: (res: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    stubFetch(() => gate);
    const src = createStaticSource<Doc>({ name: "c", url: () => "https://x/y", kvKey: "k", parse: (j) => Doc.parse(j) });
    const env = testEnv(kv);
    const p1 = src.get(env);
    const p2 = src.get(env);
    await new Promise((r) => setTimeout(r, 0)); // let the shared load reach fetch
    expect(fetchCalls).toHaveLength(1);
    release(ok(BODY, '"a"'));
    const [d1, d2] = await Promise.all([p1, p2]);
    expect(d1).toEqual(d2);
    expect(fetchCalls).toHaveLength(1);
  });
});
