import { describe, expect, it } from "vitest";
import { issueSession, SESSION_TTL_MS, verifySession } from "./session.js";
import { verifyTurnstile } from "./turnstile.js";

const SECRET = "test-secret-0123456789";
const ID = "6b0e6f0e-8a2b-4c47-9d0a-7d3b1d2c9f10";

describe("session tokens", () => {
  it("accepts a fresh token for the same conversation", async () => {
    const t = await issueSession(SECRET, ID, 1_000);
    expect(await verifySession(SECRET, ID, t, 2_000)).toBe("ok");
  });

  it("expires after the TTL", async () => {
    const t = await issueSession(SECRET, ID, 1_000);
    expect(await verifySession(SECRET, ID, t, 1_000 + SESSION_TTL_MS)).toBe("expired");
  });

  it("takes its life from ttlMs (ask.sessionHours)", async () => {
    const t = await issueSession(SECRET, ID, 1_000, 2 * 3_600_000);
    expect(await verifySession(SECRET, ID, t, 1_000 + 2 * 3_600_000 - 1)).toBe("ok");
    expect(await verifySession(SECRET, ID, t, 1_000 + 2 * 3_600_000)).toBe("expired");
  });

  it("is bound to the conversation id and the secret", async () => {
    const t = await issueSession(SECRET, ID, 1_000);
    expect(await verifySession(SECRET, "other-id", t, 2_000)).toBe("invalid");
    expect(await verifySession("another-secret", ID, t, 2_000)).toBe("invalid");
    expect(await verifySession(undefined, ID, t, 2_000)).toBe("invalid");
  });

  it("rejects a token whose expiry was pushed forward", async () => {
    const t = await issueSession(SECRET, ID, 1_000);
    const [, sig] = t.split(".");
    expect(await verifySession(SECRET, ID, `${9_999_999_999_999}.${sig}`, 2_000)).toBe("invalid");
  });

  it.each([null, undefined, ""])("reports a missing token (%s)", async (t) => {
    expect(await verifySession(SECRET, ID, t, 0)).toBe("missing");
  });

  it.each(["abc", ".x", "123.", "123.!!!", "12a.AAAA", "1." + "A".repeat(300), "1.AAAA"])("rejects junk %s", async (t) => {
    expect(await verifySession(SECRET, ID, t, 0)).toBe("invalid");
  });
});

function fakeFetch(body: unknown, capture?: (init: RequestInit) => void): typeof fetch {
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    capture?.(init ?? {});
    return Response.json(body);
  }) as typeof fetch;
}

describe("turnstile", () => {
  const base = { secret: "s", token: "tok", allowedOrigins: ["https://example.com"] };

  it("passes on success from an allowed hostname and sends secret, token and ip", async () => {
    let sent: FormData | undefined;
    const r = await verifyTurnstile({
      ...base,
      ip: "1.2.3.4",
      fetcher: fakeFetch({ success: true, hostname: "example.com" }, (i) => (sent = i.body as FormData)),
    });
    expect(r.ok).toBe(true);
    expect(sent?.get("secret")).toBe("s");
    expect(sent?.get("response")).toBe("tok");
    expect(sent?.get("remoteip")).toBe("1.2.3.4");
  });

  it("fails on another hostname unless local", async () => {
    const f = fakeFetch({ success: true, hostname: "evil.test" });
    expect(await verifyTurnstile({ ...base, fetcher: f })).toEqual({ ok: false, reason: "hostname" });
    expect((await verifyTurnstile({ ...base, local: true, fetcher: f })).ok).toBe(true);
  });

  it("fails when rejected, without token or secret, or on network error", async () => {
    expect((await verifyTurnstile({ ...base, fetcher: fakeFetch({ success: false }) })).reason).toBe("rejected");
    expect((await verifyTurnstile({ ...base, token: "" })).reason).toBe("missing_token");
    expect((await verifyTurnstile({ ...base, secret: undefined })).reason).toBe("missing_secret");
    const boom = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    expect((await verifyTurnstile({ ...base, fetcher: boom })).reason).toBe("network");
  });
});
