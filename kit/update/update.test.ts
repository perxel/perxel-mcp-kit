import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findDepMismatches, formatDepFix, isDirty, runUpdate } from "./update.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("isDirty", () => {
  it("is false for empty git status output", () => {
    expect(isDirty("")).toBe(false);
    expect(isDirty("  \n")).toBe(false);
  });

  it("is true when files changed", () => {
    expect(isDirty(" M kit/core/tool.ts\n")).toBe(true);
    expect(isDirty("?? kit/new-file.ts\n")).toBe(true);
  });
});

describe("findDepMismatches", () => {
  it("reports missing and differently-pinned deps, ignoring matches", () => {
    const kit = {
      dependencies: { a: "1.0.0", b: "2.0.0" },
      devDependencies: { c: "3.0.0", d: "4.0.0" },
    };
    const pkg = {
      dependencies: { a: "1.0.0", b: "9.9.9" },
      devDependencies: { c: "3.0.0" },
    };
    expect(findDepMismatches(kit, pkg)).toEqual([
      { name: "b", want: "2.0.0", have: "9.9.9", dev: false },
      { name: "d", want: "4.0.0", have: null, dev: true },
    ]);
  });

  it("is empty when everything matches", () => {
    const deps = { dependencies: { a: "1.0.0" }, devDependencies: { b: "2.0.0" } };
    expect(findDepMismatches(deps, deps)).toEqual([]);
  });
});

describe("formatDepFix", () => {
  it("prints regular before dev add commands", () => {
    expect(
      formatDepFix([
        { name: "d", want: "4.0.0", have: null, dev: true },
        { name: "b", want: "2.0.0", have: "9.9.9", dev: false },
      ]),
    ).toBe("pnpm add b@2.0.0\npnpm add -D d@4.0.0");
  });
});

/** Relative file paths under dir (sorted), for asserting two kit/ dirs match. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (base: string, prefix: string) => {
    for (const entry of readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(base, entry.name), rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  walk(dir, "");
  return out;
}

const SKIP = new Set(["node_modules", ".git", ".wrangler", ".idea"]);

/** A scratch clone of this repo (without heavy/ignored dirs), committed to git. */
function makeClone(): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-update-test-"));
  cpSync(REPO_ROOT, dir, {
    recursive: true,
    filter: (src) => {
      const parts = src.split("/");
      return !parts.some((p) => SKIP.has(p));
    },
  });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "clone"], { cwd: dir });
  return dir;
}

describe("runUpdate --from", () => {
  it("replaces kit/, stamps VERSION @local, regenerates version.ts", async () => {
    const clone = makeClone();
    try {
      // Stale the clone's kit/: the update must wipe this out.
      writeFileSync(join(clone, "kit", "STALE.txt"), "stale");
      writeFileSync(join(clone, "kit", "VERSION"), "stale\n");
      execFileSync("git", ["add", "-A"], { cwd: clone });
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "stale kit"], {
        cwd: clone,
      });

      await runUpdate({ root: clone, from: REPO_ROOT });

      const want = listFiles(join(REPO_ROOT, "kit"));
      const got = listFiles(join(clone, "kit"));
      expect(got).toEqual(want);
      for (const rel of want) {
        // VERSION is stamped and version.ts regenerated; both asserted below.
        if (rel === "VERSION" || rel === "core/version.ts") continue;
        const a = readFileSync(join(REPO_ROOT, "kit", rel), "utf8");
        const b = readFileSync(join(clone, "kit", rel), "utf8");
        expect(b, rel).toBe(a);
      }
      expect(statSync(join(clone, "kit", "STALE.txt"), { throwIfNoEntry: false })).toBeUndefined();
      const version = readFileSync(join(clone, "kit", "VERSION"), "utf8").trim();
      expect(version.endsWith("@local")).toBe(true);
      expect(readFileSync(join(clone, "kit", "core", "version.ts"), "utf8")).toContain(JSON.stringify(version));
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it("refuses when kit/ has uncommitted changes", async () => {
    const clone = makeClone();
    try {
      writeFileSync(join(clone, "kit", "VERSION"), "dirty\n");
      await expect(runUpdate({ root: clone, from: REPO_ROOT })).rejects.toThrow(/uncommitted changes/);
      // The refusal happens before anything is replaced.
      expect(readFileSync(join(clone, "kit", "VERSION"), "utf8")).toBe("dirty\n");
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });
});
