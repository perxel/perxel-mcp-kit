import { execFileSync } from "node:child_process";
import { cpSync, createWriteStream, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

export interface KitJson {
  repo: string;
  ref: string;
}

export interface UpdateOptions {
  /** Repo root of the clone (defaults to the current working directory). */
  root?: string;
  /** Ref to pull (defaults to kit.json ref). */
  ref?: string;
  /** Copy kit/ from this local path instead of downloading from GitHub. */
  from?: string;
  /** Skip the git dirty check (tests only; real runs always check). */
  allowDirty?: boolean;
}

/** True when `git status --porcelain` output shows uncommitted changes. */
export function isDirty(porcelain: string): boolean {
  return porcelain.trim().length > 0;
}

export interface DepMismatch {
  name: string;
  want: string;
  have: string | null; // null when missing from package.json
  dev: boolean;
}

/**
 * Compare the kit's required deps (kit/deps.json) with the clone's
 * package.json. Returns every dep that is missing or pinned differently.
 */
export function findDepMismatches(
  kitDeps: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> },
  pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> },
): DepMismatch[] {
  const out: DepMismatch[] = [];
  for (const dev of [false, true]) {
    const want = dev ? (kitDeps.devDependencies ?? {}) : (kitDeps.dependencies ?? {});
    const have = dev ? (pkg.devDependencies ?? {}) : (pkg.dependencies ?? {});
    for (const [name, version] of Object.entries(want)) {
      if (have[name] !== version) out.push({ name, want: version, have: have[name] ?? null, dev });
    }
  }
  return out;
}

/** The `pnpm add` command fixing every mismatch (regular before dev deps). */
export function formatDepFix(mismatches: DepMismatch[]): string {
  const lines: string[] = [];
  for (const dev of [false, true]) {
    const group = mismatches.filter((m) => m.dev === dev);
    if (group.length === 0) continue;
    lines.push(`pnpm add${dev ? " -D" : ""} ${group.map((m) => `${m.name}@${m.want}`).join(" ")}`);
  }
  return lines.join("\n");
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** Short sha of <ref> from the remote, or null when git/network is unavailable. */
function resolveRemoteSha(repo: string, ref: string): string | null {
  try {
    const out = execFileSync("git", ["ls-remote", `https://github.com/${repo}.git`, ref], {
      encoding: "utf8",
      timeout: 30_000,
    }).trim();
    const sha = out.split(/\s/)[0];
    return sha && /^[0-9a-f]{40}$/.test(sha) ? sha.slice(0, 7) : null;
  } catch {
    return null;
  }
}

async function downloadKit(repo: string, ref: string, dest: string): Promise<string> {
  const url = `https://codeload.github.com/${repo}/tar.gz/${ref}`;
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`kit:update: download failed: ${url} -> HTTP ${res.status}`);
  const tgz = join(dest, "kit.tgz");
  await pipeline(res.body as unknown as NodeJS.ReadableStream, createWriteStream(tgz));
  // The tarball holds a single top-level dir. Extract it whole (small repo): GNU-only
  // flags such as --wildcards break on macOS bsdtar.
  try {
    execFileSync("tar", ["-xzf", tgz, "-C", dest], { timeout: 60_000 });
  } catch (err) {
    throw new Error(`kit:update: tar extract failed (is tar installed?): ${err instanceof Error ? err.message : err}`);
  }
  const top = readdirSync(dest, { withFileTypes: true }).find((e) => e.isDirectory());
  if (!top) throw new Error("kit:update: unexpected tarball layout (no top-level dir)");
  const kitDir = join(dest, top.name, "kit");
  if (!existsSync(kitDir)) throw new Error("kit:update: tarball has no kit/ dir");
  const staged = join(dest, "kit");
  renameSync(kitDir, staged);
  return staged;
}

/**
 * Run `pnpm kit:update [ref] [--from <local path>]` against `root`:
 * refuse on dirty kit/, replace kit/, stamp kit/VERSION, regenerate
 * kit/core/version.ts, compare deps, print the diff stat.
 */
export async function runUpdate(opts: UpdateOptions = {}): Promise<void> {
  const root = resolve(opts.root ?? process.cwd());
  const kitJson = readJson(join(root, "kit.json")) as unknown as KitJson;
  const ref = opts.ref ?? kitJson.ref;
  const tmp = mkdtempSync(join(tmpdir(), "kit-update-"));
  try {
    let staged: string;
    let version: string;
    if (opts.from) {
      const src = join(resolve(opts.from), "kit");
      if (!existsSync(src)) throw new Error(`kit:update: --from has no kit/ dir: ${src}`);
      staged = join(tmp, "kit");
      cpSync(src, staged, { recursive: true });
      version = `${ref}@local`;
    } else {
      const sha = resolveRemoteSha(kitJson.repo, ref);
      staged = await downloadKit(kitJson.repo, ref, tmp);
      version = sha ? `${ref}@${sha}` : ref;
    }

    if (!opts.allowDirty) {
      let porcelain = "";
      try {
        porcelain = execFileSync("git", ["status", "--porcelain", "--", "kit/"], {
          cwd: root,
          encoding: "utf8",
        });
      } catch {
        // Not a git repo or git missing: warn and carry on (the check guards
        // uncommitted work; failing closed on a missing tool is worse).
        console.log("kit:update: warning: git status failed, skipping the dirty check");
      }
      if (isDirty(porcelain)) {
        throw new Error("kit:update: refusing: kit/ has uncommitted changes (commit or stash first)");
      }
    }

    rmSync(join(root, "kit"), { recursive: true, force: true });
    cpSync(staged, join(root, "kit"), { recursive: true });
    writeFileSync(join(root, "kit", "VERSION"), `${version}\n`);
    // version.ts is generated from VERSION (esbuild can't bundle a ?raw import).
    writeFileSync(
      join(root, "kit", "core", "version.ts"),
      `// Generated from kit/VERSION by \`pnpm kit:update\` (in this repo: kept in sync by version.test.ts).\nexport const KIT_VERSION = ${JSON.stringify(version)};\n`,
    );

    const mismatches = findDepMismatches(
      readJson(join(root, "kit", "deps.json")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      },
      readJson(join(root, "package.json")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      },
    );
    if (mismatches.length > 0) {
      console.log("kit:update: package.json differs from kit/deps.json; run:");
      console.log(formatDepFix(mismatches));
    } else {
      console.log("kit:update: package.json matches kit/deps.json");
    }

    try {
      const stat = execFileSync("git", ["diff", "--stat", "--", "kit/"], { cwd: root, encoding: "utf8" });
      console.log(stat.trim() === "" ? "kit:update: kit/ unchanged" : stat);
    } catch {
      console.log("kit:update: done (git diff unavailable)");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function parseArgs(argv: string[]): { ref?: string; from?: string } {
  let ref: string | undefined;
  let from: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--from") {
      from = argv[++i];
      if (!from) throw new Error("kit:update: --from needs a path");
    } else if (!argv[i].startsWith("--")) {
      if (ref) throw new Error("kit:update: expected at most one [ref]");
      ref = argv[i];
    } else {
      throw new Error(`kit:update: unknown flag ${argv[i]}`);
    }
  }
  return { ref, from };
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  try {
    const { ref, from } = parseArgs(process.argv.slice(2));
    await runUpdate({ ref, from });
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
