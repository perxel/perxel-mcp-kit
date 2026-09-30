import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { bySlug, clampLimit, searchItems, type StaticItem } from "./search.js";

const ItemSchema = z.object({
  type: z.string(),
  slug: z.string(),
  title: z.string(),
  excerpt: z.string(),
  url: z.string(),
  category: z.string(),
  date: z.string().nullable(),
  tags: z.array(z.string()),
  body: z.string(),
});

const ContentSchema = z.object({
  version: z.number(),
  generatedAt: z.string(),
  site: z.object({
    name: z.string(),
    url: z.string(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    address: z.string().nullable(),
    socials: z.record(z.string(), z.string()),
  }),
  items: z.array(ItemSchema),
});

function fixtureItems(): StaticItem[] {
  const dir = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(join(dir, "..", "testing", "fixtures", "content.json"), "utf8");
  return ContentSchema.parse(JSON.parse(raw)).items;
}

function item(overrides: Partial<StaticItem> & { slug: string }): StaticItem {
  return {
    type: "insight",
    title: "Untitled",
    excerpt: "No excerpt.",
    url: `https://example.com/${overrides.slug}`,
    category: "misc",
    date: null,
    tags: [],
    body: "Body text.",
    ...overrides,
  };
}

describe("clampLimit", () => {
  it("falls back for missing or nonsense input", () => {
    expect(clampLimit(undefined)).toBe(5);
    expect(clampLimit("10")).toBe(5);
    expect(clampLimit(Number.NaN)).toBe(5);
    expect(clampLimit(0)).toBe(5);
    expect(clampLimit(-3)).toBe(5);
  });

  it("passes through, floors, and caps", () => {
    expect(clampLimit(3)).toBe(3);
    expect(clampLimit(7.9)).toBe(7);
    expect(clampLimit(100)).toBe(20);
  });

  it("honours custom defaults and maxima", () => {
    expect(clampLimit(undefined, 10, 50)).toBe(10);
    expect(clampLimit(100, 10, 50)).toBe(50);
    expect(clampLimit(30, 10, 50)).toBe(30);
  });
});

describe("searchItems", () => {
  it("finds diacritic text from an ASCII query", () => {
    const hits = searchItems(fixtureItems(), "thiet ke");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].title).toBe("Thiết kế MCP cho doanh nghiệp nhỏ");
  });

  it("ranks a title match above a body-only match", () => {
    const items = [
      item({ slug: "a", title: "Unrelated title", body: "this body mentions ca phe once" }),
      item({ slug: "b", title: "Cửa hàng cà phê", body: "nothing relevant here" }),
    ];
    const hits = searchItems(items, "ca phe");
    expect(hits.map((h) => h.slug)).toEqual(["b", "a"]);
  });

  it("requires every token to match somewhere", () => {
    const hits = searchItems(fixtureItems(), "thiet ke unicorn-xyz");
    expect(hits).toEqual([]);
  });

  it("never returns the full body", () => {
    for (const hit of searchItems(fixtureItems(), "thiet ke")) {
      expect(hit).not.toHaveProperty("body");
    }
    for (const hit of searchItems(fixtureItems(), "")) {
      expect(hit).not.toHaveProperty("body");
    }
  });

  it("lists the first N items on a blank query and respects limit", () => {
    const items = fixtureItems();
    expect(searchItems(items, "", { limit: 2 }).map((h) => h.slug)).toEqual(items.slice(0, 2).map((i) => i.slug));
    expect(searchItems(items, "dich vu", { limit: 1 })).toHaveLength(1);
  });
});

describe("bySlug", () => {
  it("returns the full item with body, or undefined", () => {
    const items = fixtureItems();
    const found = bySlug(items, "goi-bao-tri-hang-nam");
    expect(found?.title).toBe("Gói bảo trì hằng năm");
    expect(found?.body.length).toBeGreaterThan(0);
    expect(bySlug(items, "no-such-slug")).toBeUndefined();
  });
});
