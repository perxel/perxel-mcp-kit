import { describe, expect, it } from "vitest";
import { allowedOrigin, preflight, withCors } from "./cors.js";

const ALLOWED = ["https://perxel.com", "https://staging.perxel.com"];

function req(origin?: string, url = "https://mcp.perxel.com/ask"): Request {
  return new Request(url, { method: "POST", headers: origin === undefined ? {} : { origin } });
}

describe("allowedOrigin", () => {
  it("returns an exactly listed origin", () => {
    expect(allowedOrigin(req("https://perxel.com"), ALLOWED)).toBe("https://perxel.com");
    expect(allowedOrigin(req("https://staging.perxel.com"), ALLOWED)).toBe("https://staging.perxel.com");
  });

  it("returns null without an Origin header", () => {
    expect(allowedOrigin(req(undefined), ALLOWED)).toBeNull();
  });

  it("returns null for an origin that is not listed", () => {
    expect(allowedOrigin(req("https://evil.com"), ALLOWED)).toBeNull();
  });

  it("rejects lookalike prefix and suffix origins", () => {
    expect(allowedOrigin(req("https://perxel.com.evil.com"), ALLOWED)).toBeNull();
    expect(allowedOrigin(req("https://evil.com.perxel.com"), ALLOWED)).toBeNull();
    expect(allowedOrigin(req("https://xperxel.com"), ALLOWED)).toBeNull();
    expect(allowedOrigin(req("https://perxel.com.evil"), ALLOWED)).toBeNull();
  });

  it("rejects a trailing slash, a subdomain, a path and the wrong scheme", () => {
    expect(allowedOrigin(req("https://perxel.com/"), ALLOWED)).toBeNull();
    expect(allowedOrigin(req("https://www.perxel.com"), ALLOWED)).toBeNull();
    expect(allowedOrigin(req("https://evil.com/https://perxel.com"), ALLOWED)).toBeNull();
    expect(allowedOrigin(req("http://perxel.com"), ALLOWED)).toBeNull();
  });

  it("allows any localhost origin only when the request host is local", () => {
    const local = ["https://perxel.com"];
    expect(allowedOrigin(req("http://localhost:3000", "http://localhost:8788/ask"), local)).toBe("http://localhost:3000");
    expect(allowedOrigin(req("http://127.0.0.1:5173", "http://127.0.0.1:8788/ask"), local)).toBe("http://127.0.0.1:5173");
    expect(allowedOrigin(req("http://localhost:3000", "https://mcp.perxel.com/ask"), local)).toBeNull();
    expect(allowedOrigin(req("http://localhost:3000", "http://localhost.evil.com:8788/ask"), local)).toBeNull();
  });

  it("rejects a localhost lookalike even on a local request", () => {
    const url = "http://localhost:8788/ask";
    expect(allowedOrigin(req("https://localhost:3000", url), ALLOWED)).toBeNull();
    expect(allowedOrigin(req("http://localhost:3000.evil.com", url), ALLOWED)).toBeNull();
    expect(allowedOrigin(req("http://127.0.0.2:3000", url), ALLOWED)).toBeNull();
  });
});

describe("preflight", () => {
  it("answers 204 with the CORS headers when allowed", () => {
    const res = preflight(req("https://perxel.com"), ALLOWED);
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://perxel.com");
    expect(res.headers.get("access-control-allow-methods")).toBe("POST");
    expect(res.headers.get("access-control-allow-headers")).toBe("content-type, x-ask-session");
    expect(res.headers.get("access-control-max-age")).toBe("600");
    expect(res.headers.get("vary")).toBe("Origin");
  });

  it("answers 403 with code origin when denied", () => {
    const res = preflight(req("https://evil.com"), ALLOWED);
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("vary")).toBe("Origin");
    expect(res.headers.get("content-type")).toContain("application/json");
    return res.json().then((body) => expect(body).toEqual({ code: "origin" }));
  });

  it("denies a preflight with no Origin header", () => {
    const res = preflight(req(undefined), ALLOWED);
    expect(res.status).toBe(403);
    return res.json().then((body) => expect(body).toEqual({ code: "origin" }));
  });
});

describe("withCors", () => {
  it("keeps status and body and adds the CORS headers", () => {
    const out = withCors(new Response("hello", { status: 201, headers: { "content-type": "text/plain" } }), "https://perxel.com");
    expect(out.status).toBe(201);
    expect(out.headers.get("access-control-allow-origin")).toBe("https://perxel.com");
    expect(out.headers.get("access-control-expose-headers")).toBe("x-ask-session");
    expect(out.headers.get("vary")).toBe("Origin");
    expect(out.headers.get("content-type")).toBe("text/plain");
    return out.text().then((t) => expect(t).toBe("hello"));
  });

  it("keeps an existing Vary value and does not stream the body eagerly", () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk"));
        controller.close();
      },
    });
    const origin = new Response(stream, { status: 200, headers: { vary: "Accept-Encoding" } });
    const out = withCors(origin, "http://localhost:3000");
    expect(out.status).toBe(200);
    expect(out.headers.get("vary")).toBe("Accept-Encoding, Origin");
    expect(out.body).not.toBeNull();
    return new Response(out.body).text().then((t) => expect(t).toBe("chunk"));
  });
});
