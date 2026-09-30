import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KIT_VERSION } from "./version.js";

describe("kit version", () => {
  it("matches kit/VERSION", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(dir, "..", "VERSION"), "utf8").trim();
    expect(KIT_VERSION).toBe(raw);
  });
});
