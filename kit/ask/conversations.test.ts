import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { McpConfig } from "../core/config.js";
import type { Env } from "../core/env.js";
import { handleConversations, isConversationsPath } from "./conversations.js";
import { appendTurn, getConversation } from "./store.js";
import { FakeD1 } from "./testing/fake-d1.js";

const ID = "6b0e6f0e-8a2b-4c47-9d0a-7d3b1d2c9f10";
const NOW = 1_800_000_000_000;
const config: McpConfig = {
  slug: "example",
  name: "Example",
  version: "1",
  description: "d",
  scopes: {},
  tools: [],
  docs: { contact: "c" },
  ask: { model: "m", systemPrompt: "x", allowedOrigins: ["https://example.com"], handoff: [], topics: ["pricing"] },
};

async function db() {
  const d = new FakeD1(readFileSync("kit/ask/migrations/0001_init.sql", "utf8")) as unknown as D1Database;
  await appendTurn(d, {
    id: ID, now: NOW - 1000, locale: "vi", page: "/", country: "VN", callerKey: "ip:x", model: "m",
    user: "<script>alert(1)</script> giá?", assistant: "Từ 20.000.000đ.", tools: [{ name: "search_content" }],
    tokensIn: 1, tokensOut: 1, costUsd: 0.001, cited: ["https://example.com/a"],
  });
  return d;
}

const prod = (path: string, init?: RequestInit) => new Request(`https://mcp.example.com${path}`, init);
const local = (path: string, init?: RequestInit) => new Request(`http://localhost:8788${path}`, init);

describe("ask conversations page", () => {
  it("matches only paths under <dash>/conversations", () => {
    expect(isConversationsPath("/dash/conversations", "/dash")).toBe(true);
    expect(isConversationsPath("/dash/conversations/x", "/dash")).toBe(true);
    expect(isConversationsPath("/dash/conversationsx", "/dash")).toBe(false);
    expect(isConversationsPath("/dash/", "/dash")).toBe(false);
  });

  it("stays behind Access even when the dashboard is public", async () => {
    const env = { ASK_DB: await db(), DASH_PUBLIC: "true", MCP_PUBLIC_URL: "https://mcp.example.com" } as unknown as Env;
    const unconfigured = await handleConversations(prod("/dash/conversations/"), env, config, "/dash", NOW);
    expect(unconfigured.status).toBe(503);
    const withAccess = { ...env, DASH_ACCESS_TEAM: "team.cloudflareaccess.com", ASK_DASH_ACCESS_AUD: "aud" } as Env;
    const noJwt = await handleConversations(prod("/dash/conversations/"), withAccess, config, "/dash", NOW);
    expect(noJwt.status).toBe(403);
    expect(await noJwt.text()).not.toContain("giá");
    const badJwt = await handleConversations(
      prod("/dash/conversations/", { headers: { "cf-access-jwt-assertion": "a.b.c" } }),
      withAccess,
      config,
      "/dash",
      NOW,
    );
    expect(badJwt.status).toBe(403);
  });

  it("lists and shows a conversation locally, escaping visitor text", async () => {
    const env = { ASK_DB: await db() } as unknown as Env;
    const list = await handleConversations(local("/dash/conversations/"), env, config, "/dash", NOW);
    expect(list.status).toBe(200);
    expect(await list.text()).toContain(`/dash/conversations/${ID}`);
    const detail = await handleConversations(local(`/dash/conversations/${ID}`), env, config, "/dash", NOW);
    const html = await detail.text();
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("https://example.com/a");
  });

  it("refuses cross-site POSTs in production", async () => {
    const env = { ASK_DB: await db(), MCP_PUBLIC_URL: "https://mcp.example.com" } as unknown as Env;
    // Access is checked first; this request has no JWT, so it never reaches the action.
    const res = await handleConversations(
      prod(`/dash/conversations/${ID}`, { method: "POST", headers: { origin: "https://evil.test" }, body: new URLSearchParams({ action: "delete" }) }),
      env,
      config,
      "/dash",
      NOW,
    );
    expect(res.status).toBe(503);
    expect(await getConversation(env.ASK_DB as D1Database, ID)).not.toBeNull();
  });

  it("keeps a visitor question and deletes a conversation", async () => {
    const d = await db();
    const env = { ASK_DB: d } as unknown as Env;
    const keep = await handleConversations(
      local(`/dash/conversations/${ID}`, { method: "POST", body: new URLSearchParams({ action: "keep", seq: "0", note: "price" }) }),
      env,
      config,
      "/dash",
      NOW,
    );
    expect(keep.status).toBe(303);
    const kept = await d.prepare("SELECT text, note FROM kept_questions").all<{ text: string; note: string }>();
    expect(kept.results).toEqual([{ text: "<script>alert(1)</script> giá?", note: "price" }]);
    const notUser = await handleConversations(
      local(`/dash/conversations/${ID}`, { method: "POST", body: new URLSearchParams({ action: "keep", seq: "1" }) }),
      env,
      config,
      "/dash",
      NOW,
    );
    expect(notUser.status).toBe(400);
    const del = await handleConversations(
      local(`/dash/conversations/${ID}`, { method: "POST", body: new URLSearchParams({ action: "delete" }) }),
      env,
      config,
      "/dash",
      NOW,
    );
    expect(del.status).toBe(303);
    expect(await getConversation(d, ID)).toBeNull();
  });

  it("404s on a malformed id", async () => {
    const env = { ASK_DB: await db() } as unknown as Env;
    const res = await handleConversations(local("/dash/conversations/not-a-uuid"), env, config, "/dash", NOW);
    expect(res.status).toBe(404);
  });
});
