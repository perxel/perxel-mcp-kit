import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../core/env.js";
import { createWorker } from "../core/worker.js";
import config from "../../mcp.config.js";
import {
  TEST_ACCESS,
  TEST_ACCESS_EMAIL,
  TEST_ACCESS_SUB,
  TEST_PUBLIC_URL,
  createCaller,
  fakeExecCtx,
  gateTestEnv,
  makeAccessKey,
  mintToken,
  stubAccessFetch,
  type GateTestEnv,
} from "./oauth-helper.js";

/**
 * Gate tests (task 3.2): the 200/401/403 paths, both tool-name sources, the
 * metadata documents, the token endpoint, refresh, redirect-URI policy and
 * the consent page. Tokens are real ones minted through the in-process
 * provider flow (`mintToken`); Access is stubbed (signed id_token + JWKS).
 */

const worker = createWorker(config);
// Any public tool that accepts no arguments stands in for "a public call", so
// the gate tests run against whatever tools the clone defines.
const publicTool = config.tools.find((t) => t.access === "public" && t.inputSchema.safeParse({}).success);
// The private-tool gate paths need the example's private `whoami`; a clone with only public tools skips them.
const hasPrivateTool = config.tools.some((t) => t.name === "whoami" && t.access === "private");
let gateEnv: GateTestEnv;
let restoreFetch: () => void;

beforeAll(async () => {
  gateEnv = gateTestEnv();
  const key = await makeAccessKey();
  const idToken = await key.signIdToken({
    sub: TEST_ACCESS_SUB,
    email: TEST_ACCESS_EMAIL,
    aud: TEST_ACCESS.clientId,
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
  });
  restoreFetch = stubAccessFetch(key.jwks, idToken);
  return restoreFetch;
});

function mcpRequest(body: unknown, headers: Record<string, string> = {}, id = 7): Request {
  return new Request(`${TEST_PUBLIC_URL}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "CF-Connecting-IP": "1.2.3.4",
      "user-agent": "gate-test",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function toolCallBody(name: string, args: Record<string, unknown> = {}, id = 7) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

/** The JSON-RPC result out of the SSE envelope the stateless handler sends. */
async function rpcResult(res: Response): Promise<{ result?: Record<string, unknown>; error?: unknown }> {
  const text = await res.text();
  const dataLine = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("data:"));
  return JSON.parse(dataLine ? dataLine.slice("data:".length).trim() : text) as {
    result?: Record<string, unknown>;
    error?: unknown;
  };
}

async function postMcp(env: Env, body: unknown, headers: Record<string, string> = {}) {
  const ex = fakeExecCtx();
  const res = await worker.fetch(mcpRequest(body, headers), env, ex.ctx);
  await ex.drain();
  return res;
}

const PUBLIC_URL = TEST_PUBLIC_URL;
const RESOURCE = `${PUBLIC_URL}/mcp`;
const META = `${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp`;

describe("gate", () => {
  it("public call without token → 200", async () => {
    const res = await postMcp(gateEnv.env, toolCallBody(publicTool!.name));
    expect(res.status).toBe(200);
    const msg = await rpcResult(res);
    // The gate let it through; a content-backed tool may still answer isError here (no source in the test env).
    expect(msg.error).toBeUndefined();
    expect(msg.result).toBeDefined();
  });

  it.skipIf(!hasPrivateTool)("private call without token → 401 with the exact challenge", async () => {
    const before = gateEnv.points.length;
    const res = await postMcp(gateEnv.env, toolCallBody("whoami"));
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe(`Bearer resource_metadata="${META}", scope="private:read"`);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    const rows = gateEnv.points.slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0].blobs?.slice(0, 4)).toEqual([config.slug, "whoami", "unauthorized", ""]);
    expect(rows[0].blobs?.[5]).toBe("private");
    expect(rows[0].blobs?.[6]).toBe("anon");
  });

  it.skipIf(!hasPrivateTool)("Mcp-Name header path → 401 (body carries no tools/call)", async () => {
    const res = await postMcp(gateEnv.env, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, {
      "Mcp-Method": "tools/call",
      "Mcp-Name": "whoami",
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain('scope="private:read"');
  });

  it.skipIf(!hasPrivateTool)("batch containing one private call → 401", async () => {
    const before = gateEnv.points.length;
    const res = await postMcp(gateEnv.env, [
      toolCallBody(publicTool!.name, {}, 1),
      toolCallBody("whoami", {}, 2),
    ]);
    expect(res.status).toBe(401);
    // One row per tools/call in the batch.
    expect(gateEnv.points.slice(before)).toHaveLength(2);
  });

  it("unknown tool without token passes the gate (the SDK answers the error)", async () => {
    const res = await postMcp(gateEnv.env, toolCallBody("nope_tool"));
    expect(res.status).toBe(200);
  });
});

describe("authenticated calls", () => {
  let accessToken = "";
  let refreshToken = "";
  let clientId = "";

  beforeAll(async () => {
    const minted = await mintToken(worker, gateEnv.env);
    accessToken = minted.accessToken;
    refreshToken = minted.refreshToken;
    clientId = minted.clientId;
    expect(refreshToken).not.toBe("");
  });

  const authHeaders = () => ({ Authorization: `Bearer ${accessToken}` });

  it.skipIf(!hasPrivateTool)("valid token with the scope → 200 and whoami returns the user", async () => {
    const before = gateEnv.points.length;
    const res = await postMcp(gateEnv.env, toolCallBody("whoami"), authHeaders());
    expect(res.status).toBe(200);
    const msg = await rpcResult(res);
    expect(msg.result?.["isError"]).toBeUndefined();
    const content = msg.result?.["content"] as { type: string; text: string }[];
    expect(JSON.parse(content[0].text)).toMatchObject({ userId: TEST_ACCESS_SUB, email: TEST_ACCESS_EMAIL });
    const rows = gateEnv.points.slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0].blobs?.slice(1, 3)).toEqual(["whoami", "ok"]);
    expect(rows[0].blobs?.[5]).toBe("private");
    expect(rows[0].blobs?.[6]).toBe("user");
    expect(rows[0].indexes?.[0]).toMatch(/^u:[0-9a-f]{16}$/);
  });

  it("public call carrying a valid token → 200", async () => {
    const res = await postMcp(gateEnv.env, toolCallBody(publicTool!.name), authHeaders());
    expect(res.status).toBe(200);
    const msg = await rpcResult(res);
    expect(msg.error).toBeUndefined();
    expect(msg.result).toBeDefined();
  });

  it.skipIf(!hasPrivateTool)("dead token → provider 401 and an unauthorized row", async () => {
    const before = gateEnv.points.length;
    const res = await postMcp(gateEnv.env, toolCallBody("whoami"), { Authorization: "Bearer dead-token" });
    expect(res.status).toBe(401);
    const rows = gateEnv.points.slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0].blobs?.slice(1, 4)).toEqual(["whoami", "unauthorized", "invalid_token"]);
  });

  it.skipIf(!hasPrivateTool)("valid token lacking the scope → 403 insufficient_scope", async () => {
    const scopedOut = await mintToken(worker, gateEnv.env, { scope: "" });
    const before = gateEnv.points.length;
    const res = await postMcp(gateEnv.env, toolCallBody("whoami"), {
      Authorization: `Bearer ${scopedOut.accessToken}`,
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("WWW-Authenticate")).toContain('error="insufficient_scope"');
    expect(res.headers.get("WWW-Authenticate")).toContain('scope="private:read"');
    expect(res.headers.get("WWW-Authenticate")).toContain(`resource_metadata="${META}"`);
    expect(await res.json()).toMatchObject({ error: "insufficient_scope" });
    const rows = gateEnv.points.slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0].blobs?.slice(1, 4)).toEqual(["whoami", "forbidden", "insufficient_scope"]);
    expect(rows[0].blobs?.[6]).toBe("user");
  });

  it("refresh token rotates: a fresh access token works", async () => {
    const { call } = createCaller(worker, gateEnv.env);
    const res = await call("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }).toString(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string };
    const rotated = await postMcp(gateEnv.env, toolCallBody("whoami"), {
      Authorization: `Bearer ${body.access_token}`,
    });
    expect(rotated.status).toBe(200);
  });

  it("dead refresh token → invalid_grant", async () => {
    const { call } = createCaller(worker, gateEnv.env);
    const res = await call("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "nope", client_id: clientId }).toString(),
    });
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_grant" });
  });
});

describe("metadata", () => {
  it("both protected-resource paths advertise resource == <publicUrl>/mcp", async () => {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const ex = fakeExecCtx();
      const res = await worker.fetch(new Request(`${PUBLIC_URL}${path}`), gateEnv.env, ex.ctx);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        resource: RESOURCE,
        authorization_servers: [`${PUBLIC_URL}`],
      });
    }
  });

  it("authorization-server metadata: S256, none, CIMD", async () => {
    const ex = fakeExecCtx();
    const res = await worker.fetch(new Request(`${PUBLIC_URL}/.well-known/oauth-authorization-server`), gateEnv.env, ex.ctx);
    expect(res.status).toBe(200);
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta["code_challenge_methods_supported"]).toContain("S256");
    expect(meta["token_endpoint_auth_methods_supported"]).toContain("none");
    expect(meta["client_id_metadata_document_supported"]).toBe(true);
  });
});

describe("redirect URIs and consent", () => {
  it("DCR with a foreign redirect URI is refused", async () => {
    const { call } = createCaller(worker, gateEnv.env);
    const res = await call("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://evil.example/cb"], client_name: "evil" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_client_metadata" });
  });

  it("authorize with an unregistered redirect URI renders a local error", async () => {
    const { call } = createCaller(worker, gateEnv.env);
    const reg = await call("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://localhost:9999/callback"],
        client_name: "redir-test",
        token_endpoint_auth_method: "none",
      }),
    });
    const clientId = ((await reg.json()) as { client_id: string }).client_id;
    const res = await call(
      `/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: "https://evil.example/cb",
        state: "s",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
      }).toString()}`,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/redirect uri/i);
  });

  it("consent page shows the redirect hostname and the localhost warning", async () => {
    const { call } = createCaller(worker, gateEnv.env);
    const reg = await call("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://localhost:4567/callback"],
        client_name: "Loopback App",
        token_endpoint_auth_method: "none",
      }),
    });
    const clientId = ((await reg.json()) as { client_id: string }).client_id;
    const res = await call(
      `/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: "http://localhost:4567/callback",
        scope: "private:read",
        state: "s",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
        resource: RESOURCE,
      }).toString()}`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("localhost");
    expect(html).toContain("your own computer");
    expect(html).toContain("private:read");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("consent page for Claude shows claude.ai with no loopback warning", async () => {
    const { call } = createCaller(worker, gateEnv.env);
    const reg = await call("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
        client_name: "Claude",
        token_endpoint_auth_method: "none",
      }),
    });
    const clientId = ((await reg.json()) as { client_id: string }).client_id;
    const res = await call(
      `/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: "https://claude.ai/api/mcp/auth_callback",
        scope: "private:read",
        state: "s",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
        resource: RESOURCE,
      }).toString()}`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("claude.ai");
    expect(html).not.toContain("your own computer");
  });

  it("deny returns access_denied to the client", async () => {
    const { call } = createCaller(worker, gateEnv.env);
    const reg = await call("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://localhost:1111/callback"],
        client_name: "Deny App",
        token_endpoint_auth_method: "none",
      }),
    });
    const clientId = ((await reg.json()) as { client_id: string }).client_id;
    const page = await call(
      `/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: "http://localhost:1111/callback",
        state: "deny-state",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
        resource: RESOURCE,
      }).toString()}`,
    );
    const handle = (await page.text()).match(/name="handle" value="([^"]+)"/)?.[1];
    expect(handle).toBeTruthy();
    const denied = await call("/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ handle: handle as string, decision: "deny" }).toString(),
    });
    expect(denied.status).toBe(302);
    const backTo = new URL(denied.headers.get("location") ?? "");
    expect(backTo.searchParams.get("error")).toBe("access_denied");
    expect(backTo.searchParams.get("state")).toBe("deny-state");
  });
});
