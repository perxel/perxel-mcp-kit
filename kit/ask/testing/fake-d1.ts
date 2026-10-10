/**
 * Ask tests: a minimal in-memory stand-in for `D1Database`, backed by the
 * `node:sqlite` built-in (Node 22+). It implements the subset of the D1 API
 * the Ask store uses — `prepare().bind().first()/all()/run()` and `batch()`
 * — by executing the real SQL against SQLite.
 *
 * Test-only. Production code paths never import this file.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export interface FakeD1Result<T = Record<string, unknown>> {
  results: T[];
  success: true;
  meta: Record<string, unknown>;
}

export class FakeD1Statement {
  constructor(
    private native: DatabaseSync,
    readonly sql: string,
    private params: SQLInputValue[] = [],
  ) {}

  bind(...values: SQLInputValue[]): FakeD1Statement {
    return new FakeD1Statement(this.native, this.sql, values);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null>;
  async first<T = unknown>(colName: string): Promise<T | null>;
  async first<T>(colName?: string): Promise<T | null> {
    const row = this.native.prepare(this.sql).get(...this.params) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    if (typeof colName === "string") {
      const value = row[colName] as T | null | undefined;
      return value ?? null;
    }
    return row as unknown as T;
  }

  async all<T = Record<string, unknown>>(): Promise<FakeD1Result<T>> {
    const rows = this.native.prepare(this.sql).all(...this.params) as T[];
    return { results: rows, success: true as const, meta: {} };
  }

  async run<T = Record<string, unknown>>(): Promise<FakeD1Result<T>> {
    this.native.prepare(this.sql).run(...this.params);
    return { results: [], success: true as const, meta: {} };
  }
}

export class FakeD1 {
  readonly native: DatabaseSync;

  /** When `schemaSql` is given (e.g. the real migration file), it is applied on creation. */
  constructor(schemaSql?: string) {
    this.native = new DatabaseSync(":memory:");
    if (schemaSql) this.native.exec(schemaSql);
  }

  prepare(sql: string): FakeD1Statement {
    return new FakeD1Statement(this.native, sql);
  }

  async batch<T = Record<string, unknown>>(statements: FakeD1Statement[]): Promise<FakeD1Result<T>[]> {
    const out: FakeD1Result<T>[] = [];
    for (const s of statements) out.push(await s.run<T>());
    return out;
  }

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    this.native.exec(sql);
    return { count: 0, duration: 0 };
  }
}
