import { describe, expect, it } from "vitest";
import type { Env } from "../../kit/core/env.js";
import type { ToolContext } from "../../kit/core/tool.js";
import { getTimeTool } from "./get-time.js";
import { whoamiTool } from "./whoami.js";

function ctx(auth: ToolContext["auth"]): ToolContext {
  return {
    env: {} as Env,
    auth,
    requestId: "test-request",
    log: () => {},
  };
}

describe("get_time", () => {
  it("returns the current time in the default timezone", async () => {
    const before = Date.now();
    const result = await getTimeTool.execute({}, ctx(null));
    const after = Date.now();
    const data = result.data as { time: string; timezone: string; human: string };
    expect(data.timezone).toBe("Asia/Ho_Chi_Minh");
    expect(new Date(data.time).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(data.time).getTime()).toBeLessThanOrEqual(after);
    expect(typeof data.human).toBe("string");
  });

  it("honours an explicit timezone", async () => {
    const result = await getTimeTool.execute({ timezone: "UTC" }, ctx(null));
    expect((result.data as { timezone: string }).timezone).toBe("UTC");
  });

  it("rejects an unknown timezone", async () => {
    await expect(getTimeTool.execute({ timezone: "Mars/Olympus" }, ctx(null))).rejects.toThrow(
      /Unknown timezone/,
    );
  });
});

describe("whoami", () => {
  it("returns the user id and email from ctx.auth", async () => {
    const result = await whoamiTool.execute(
      {},
      ctx({ userId: "user-123", email: "a@perxel.com", scopes: ["private:read"] }),
    );
    expect(result.data).toEqual({ userId: "user-123", email: "a@perxel.com" });
  });

  it("fails without auth", async () => {
    await expect(whoamiTool.execute({}, ctx(null))).rejects.toThrow(/Not signed in/);
  });
});
