import { describe, expect, it } from "vitest";
import { validateQuery } from "./validate.js";

const DS = "mcp_example";

const ALLOWED =
  "SELECT $timeSeries AS t, blob2 AS tool, SUM(_sample_interval) AS calls " +
  `FROM ${DS} WHERE $timeFilter GROUP BY blob2, t ORDER BY t`;

describe("validateQuery", () => {
  it("allows a plain dashboard query over the key's dataset", () => {
    expect(validateQuery(ALLOWED, DS)).toEqual({ ok: true });
  });

  it("allows a trailing FORMAT JSON clause and a trailing semicolon", () => {
    expect(validateQuery(`${ALLOWED} FORMAT JSON`, DS)).toEqual({ ok: true });
    expect(validateQuery(`${ALLOWED};`, DS)).toEqual({ ok: true });
    expect(validateQuery(`${ALLOWED} FORMAT JSON;  \n`, DS)).toEqual({ ok: true });
  });

  it("is case-insensitive for keywords but exact for the dataset", () => {
    expect(validateQuery(`select blob2 from ${DS} where $timeFilter`, DS)).toEqual({ ok: true });
    expect(validateQuery(`SELECT blob2 FROM ${DS.toUpperCase()} WHERE $timeFilter`, DS)).toEqual({
      ok: false,
      reason: "dataset_forbidden",
    });
  });

  it("rejects another dataset", () => {
    expect(validateQuery(ALLOWED.replace(DS, "mcp_khatra"), DS)).toEqual({
      ok: false,
      reason: "dataset_forbidden",
    });
  });

  it("rejects UNION to another dataset", () => {
    expect(
      validateQuery(`SELECT blob2 FROM ${DS} WHERE $timeFilter UNION ALL SELECT blob2 FROM mcp_other WHERE $timeFilter`, DS),
    ).toEqual({ ok: false, reason: "dataset_forbidden" });
  });

  it("rejects a subquery to another dataset", () => {
    expect(
      validateQuery(`SELECT * FROM (SELECT blob2 FROM mcp_other WHERE $timeFilter) WHERE $timeFilter`, DS),
    ).toEqual({ ok: false, reason: "dataset_forbidden" });
  });

  it("rejects a comment-hidden table", () => {
    expect(validateQuery(`SELECT blob2 FROM /* hidden */ mcp_other WHERE $timeFilter`, DS)).toEqual({
      ok: false,
      reason: "dataset_forbidden",
    });
    expect(validateQuery(`SELECT blob2 FROM -- hidden\n mcp_other WHERE $timeFilter`, DS)).toEqual({
      ok: false,
      reason: "dataset_forbidden",
    });
  });

  it("allows a string literal containing FROM another dataset", () => {
    expect(validateQuery(`SELECT blob2 FROM ${DS} WHERE blob2 = 'FROM mcp_other' AND $timeFilter`, DS)).toEqual({
      ok: true,
    });
  });

  it("ignores semicolons inside string literals", () => {
    expect(validateQuery(`SELECT blob2 FROM ${DS} WHERE blob2 = 'a;b' AND $timeFilter`, DS)).toEqual({ ok: true });
  });

  it("rejects two statements", () => {
    expect(validateQuery(`SELECT blob2 FROM ${DS} WHERE $timeFilter; SELECT blob2 FROM ${DS}`, DS)).toEqual({
      ok: false,
      reason: "multiple_statements",
    });
  });

  it("rejects writes (INTO, ATTACH)", () => {
    expect(validateQuery(`INSERT INTO ${DS} VALUES (1)`, DS)).toEqual({ ok: false, reason: "write_forbidden" });
    expect(validateQuery(`attach table ${DS}`, DS)).toEqual({ ok: false, reason: "write_forbidden" });
  });

  it("rejects system tables", () => {
    expect(validateQuery("SELECT * FROM system.tables", DS)).toEqual({ ok: false, reason: "system_forbidden" });
  });

  it("rejects quoted or backticked identifiers that do not match", () => {
    expect(validateQuery('SELECT blob2 FROM "mcp_other" WHERE $timeFilter', DS)).toEqual({
      ok: false,
      reason: "dataset_forbidden",
    });
    expect(validateQuery("SELECT blob2 FROM `mcp_other` WHERE $timeFilter", DS)).toEqual({
      ok: false,
      reason: "dataset_forbidden",
    });
  });

  it("allows quoted identifiers that match the dataset", () => {
    expect(validateQuery(`SELECT blob2 FROM "${DS}" WHERE $timeFilter`, DS)).toEqual({ ok: true });
    expect(validateQuery(`SELECT blob2 FROM \`${DS}\` WHERE $timeFilter`, DS)).toEqual({ ok: true });
  });

  it("rejects dotted (db.table) targets", () => {
    expect(validateQuery(`SELECT blob2 FROM default.${DS} WHERE $timeFilter`, DS)).toEqual({
      ok: false,
      reason: "dataset_forbidden",
    });
  });

  it("rejects JOINs to another dataset", () => {
    expect(
      validateQuery(
        `SELECT a.blob2 FROM ${DS} a JOIN mcp_other b ON a.blob2 = b.blob2 WHERE $timeFilter`,
        DS,
      ),
    ).toEqual({ ok: false, reason: "dataset_forbidden" });
    expect(
      validateQuery(`SELECT a.blob2 FROM ${DS} a JOIN ${DS} b ON a.blob2 = b.blob2 WHERE $timeFilter`, DS),
    ).toEqual({ ok: true });
  });

  it("rejects queries with no dataset (SHOW TABLES, SELECT 1)", () => {
    expect(validateQuery("SHOW TABLES", DS)).toEqual({ ok: false, reason: "no_dataset" });
    expect(validateQuery("SELECT 1", DS)).toEqual({ ok: false, reason: "no_dataset" });
  });

  it("rejects empty queries", () => {
    expect(validateQuery("", DS)).toEqual({ ok: false, reason: "empty_query" });
    expect(validateQuery("   ", DS)).toEqual({ ok: false, reason: "empty_query" });
  });
});

describe("comma joins", () => {
  it("rejects a second table added with a comma", () => {
    expect(validateQuery("SELECT 1 FROM mcp_a, mcp_b", "mcp_a").ok).toBe(false);
    expect(validateQuery("SELECT 1 FROM mcp_a AS a, mcp_b", "mcp_a").ok).toBe(false);
    expect(validateQuery("SELECT 1 FROM mcp_a a,\n mcp_b", "mcp_a").ok).toBe(false);
  });
});
