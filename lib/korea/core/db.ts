// lib/korea/core/db.ts
//
// Single server-side Postgres client (Neon serverless driver). Runs ONLY on the
// Vercel backend; reachable only with DATABASE_URL. There is no public API to the
// database (unlike Supabase's PostgREST), so the DB is closed by construction — the
// whole security surface is the serverless layer + keeping DATABASE_URL server-side.
//
// Narrow surface: getSql() -> tagged-template query function. Values in `sql`...``
// are BOUND parameters (never string-interpolated) => parameterized by default.
//
// The `neon()` HTTP driver is stateless per query (no pool/socket to close), which
// fits serverless. Use the POOLED DATABASE_URL for functions; DDL/migrations use the
// unpooled string (see db/README.md).

import { neon } from '@neondatabase/serverless';

// Narrow the tagged-template return to plain rows. With default options the driver
// always yields Record<string, unknown>[]; typing it directly keeps the overload
// union (any[][] | Record<string,any>[] | FullQueryResults) from surfacing at every
// call site. Callers cast rows to their own row shape where they read fields.
type Row = Record<string, unknown>;
type SqlTag = (strings: TemplateStringsArray, ...params: unknown[]) => Promise<Row[]>;

let sql: SqlTag | null = null;

/** Lazily create and memoize the Neon query function (tagged template → rows). */
export function getSql(): SqlTag {
  if (sql) return sql;
  const url = process.env.DATABASE_URL;
  if (!url) {
    // Fail fast: a misconfigured deployment must not silently degrade.
    throw new Error('db: DATABASE_URL must be set');
  }
  sql = neon(url) as unknown as SqlTag;
  return sql;
}

/** Test-only reset of the memoized client. Not used by request handlers. */
export function __resetDbForTests(): void {
  sql = null;
}
