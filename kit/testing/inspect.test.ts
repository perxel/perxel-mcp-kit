import { describe, expect, it } from "vitest";
import { DEFAULT_URL, parseInspectArgs } from "./inspect.js";

describe("pnpm inspect args", () => {
  it("defaults to the local wrangler dev server", () => {
    expect(parseInspectArgs([])).toEqual({ url: DEFAULT_URL });
  });

  it("refuses a remote URL without --allow-remote", () => {
    expect(parseInspectArgs(["https://mcp.example.com/mcp"])).toHaveProperty("error");
    expect(parseInspectArgs(["https://mcp.example.com/mcp", "--allow-remote"])).toEqual({ url: "https://mcp.example.com/mcp" });
  });

  it("wants the /mcp endpoint, not the site root", () => {
    expect(parseInspectArgs(["https://mcp.example.com", "--allow-remote"])).toHaveProperty("error");
    expect(parseInspectArgs(["not a url"])).toHaveProperty("error");
  });
});
