/**
 * SQL guard for the metrics proxy (section 3.11 of the task list).
 *
 * Why this exists: the Cloudflare Analytics Engine SQL token is account-wide
 * and cannot be scoped to one dataset. The proxy holds the only real token
 * and hands each dashboard its own key; this validator runs before forwarding
 * so a dashboard key can only ever read its own dataset, even through a bug
 * or a leaked key.
 *
 * Pure function, no I/O, heavily tested in `validate.test.ts`.
 */

export interface ValidationResult {
  ok: boolean;
  /** Machine-readable reason, present when `ok` is false. */
  reason?: string;
}

/**
 * Blank out `--` / `#` line comments, block comments and
 * single-quoted string literals, so checks below only see real SQL.
 * Double-quoted and backticked identifiers are kept: a `FROM "other"` or
 * ``FROM `other` `` must be caught by the table check, not hidden.
 */
function blankCommentsAndStrings(sql: string): string {
  const out = sql.split("");
  const n = sql.length;
  let i = 0;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) out[k] = " ";
  };
  while (i < n) {
    const c = sql[i];
    // Single-quoted string: '' is an escaped quote, \x is an escape.
    if (c === "'") {
      const start = i;
      i++;
      while (i < n) {
        if (sql[i] === "\\") {
          i += 2;
        } else if (sql[i] === "'") {
          if (sql[i + 1] === "'") i += 2;
          else {
            i++;
            break;
          }
        } else {
          i++;
        }
      }
      blank(start, i);
      continue;
    }
    // Line comments: -- (only when it starts a comment, i.e. not inside an
    // expression like `a--b`; ClickHouse treats -- as a comment anyway, so a
    // bare check is the safe direction) and #.
    if (c === "-" && sql[i + 1] === "-") {
      const start = i;
      while (i < n && sql[i] !== "\n") i++;
      blank(start, i);
      continue;
    }
    if (c === "#") {
      const start = i;
      while (i < n && sql[i] !== "\n") i++;
      blank(start, i);
      continue;
    }
    // Block comment.
    if (c === "/" && sql[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      blank(start, Math.min(i, n));
      continue;
    }
    i++;
  }
  return out.join("");
}

const BARE_IDENT = "[A-Za-z_][\\w$]*";
const QUOTED_IDENT = '"[^"]*"|`[^`]*`';
// FROM/JOIN target: a bare, double-quoted or backticked identifier, with
// optional dotted parts (db.table). Anything else (a parenthesis for a
// subquery is handled by skipping; anything else is rejected).
const FROM_JOIN_RE = new RegExp(
  `\\b(?:FROM|JOIN)\\s*(${QUOTED_IDENT}|${BARE_IDENT}(?:\\s*\\.\\s*(?:${QUOTED_IDENT}|${BARE_IDENT}))*|\\()`,
  "gi",
);

function unquote(ident: string): string {
  const t = ident.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("`") && t.endsWith("`")))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * True when `sql` is a read-only query against exactly `dataset`.
 * Allows `FROM <dataset>` with and without a trailing `FORMAT ...` clause.
 */
export function validateQuery(sql: string, dataset: string): ValidationResult {
  if (!sql || sql.trim() === "") return { ok: false, reason: "empty_query" };
  const code = blankCommentsAndStrings(sql);

  // One statement only: a `;` with anything but whitespace after it means a
  // second statement follows. A single trailing `;` is tolerated.
  if (/;[\s\S]*\S/.test(code)) return { ok: false, reason: "multiple_statements" };

  // No writes or admin reads. Word boundaries so `attach_rate` (a column
  // alias) doesn't trip the check, while `INSERT INTO` and `ATTACH` do.
  if (/\binto\b/i.test(code)) return { ok: false, reason: "write_forbidden" };
  if (/\battach\b/i.test(code)) return { ok: false, reason: "write_forbidden" };
  // No system tables (also caught by the table check below; this is the
  // explicit belt-and-braces rejection from the task list).
  if (/(^|[^A-Za-z0-9_$])system\./i.test(code)) return { ok: false, reason: "system_forbidden" };

  // Every FROM/JOIN target must be exactly the key's dataset. Quoted and
  // backticked identifiers are unquoted first, so `FROM "other"` and
  // ``FROM `other` `` reject while `FROM "mcp_x"` allows.
  FROM_JOIN_RE.lastIndex = 0;
  let found = 0;
  let m: RegExpExecArray | null;
  while ((m = FROM_JOIN_RE.exec(code)) !== null) {
    const target = m[1];
    if (target === "(") continue; // subquery: its inner FROMs are scanned too
    found++;
    // A dotted target (db.table) never equals a bare dataset name.
    const parts = target
      .split(".")
      .map((p) => unquote(p))
      .join(".");
    if (parts !== dataset) return { ok: false, reason: "dataset_forbidden" };
    // Comma join (`FROM mcp_a, mcp_b`) adds a second table with no FROM/JOIN
    // keyword, so the scan above would miss it. Reject any comma right after
    // a target (with an optional alias).
    const rest = code.slice(m.index + m[0].length);
    if (/^\s*(?:AS\s+)?(?:[A-Za-z_][\w$]*)?\s*,/i.test(rest)) {
      return { ok: false, reason: "dataset_forbidden" };
    }
  }
  // No FROM at all (SELECT 1, SHOW TABLES, ...) reads nothing we allow.
  if (found === 0) return { ok: false, reason: "no_dataset" };

  return { ok: true };
}
