// lib/korea/config.ts
//
// Server-side feature flags / tunables, read from the `config` table (jsonb values)
// with a short in-process cache and safe fallbacks. Written by admin/service only.

import { getSql } from './core/db.js';

const TTL_MS = 60_000;
let cache: Map<string, unknown> | null = null;
let cachedAt = 0;
let inflight: Promise<Map<string, unknown>> | null = null;

async function loadAll(): Promise<Map<string, unknown>> {
  const now = Date.now();
  if (cache && now - cachedAt < TTL_MS) return cache;
  // Dedup concurrent refreshes: a burst of getConfig* on an expired cache (e.g. one
  // Promise.all of 6 reads) shares ONE `select * from config` instead of firing six.
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const sql = getSql();
      const rows = await sql`select key, value from config`;
      const m = new Map<string, unknown>();
      for (const r of rows) m.set(r.key as string, r.value);
      cache = m;
      cachedAt = Date.now();
      return m;
    } catch {
      // On a DB blip, reuse the last good cache if we have one; else empty (fallbacks apply).
      return cache ?? new Map<string, unknown>();
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export async function getConfigNumber(key: string, fallback: number): Promise<number> {
  const v = (await loadAll()).get(key);
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export async function getConfigString(key: string, fallback: string): Promise<string> {
  const v = (await loadAll()).get(key);
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

export async function getConfigBool(key: string, fallback: boolean): Promise<boolean> {
  const v = (await loadAll()).get(key);
  return typeof v === 'boolean' ? v : fallback;
}

/**
 * A LIST of strings from a jsonb value — the shape an allow-list needs (`acq_sources_allowed`).
 *
 * Deliberately tolerant about how the owner typed it, because he edits this by hand in the Neon
 * console and a shape he did not expect must not silently mean "nothing is allowed":
 *   * `["a","b"]`   -> ['a','b']            (the documented form)
 *   * `"a, b"`      -> ['a','b']            (a single string; split on comma/semicolon/space)
 *   * `[]`          -> []                   (EXPLICITLY empty — an intentional "off", NOT the fallback)
 *   * missing / number / object / bool -> fallback
 * Non-string members of an array are dropped rather than coerced (`["a",1]` -> ['a']): a list of
 * identifiers with a number in it is a typo, and inventing "1" as an entry would be worse than
 * ignoring it. Empty strings are dropped for the same reason.
 *
 * NOTE the difference between "key absent" (fallback) and "key present but empty" (empty list) —
 * callers that are fail-closed pass `[]` as the fallback, so the two coincide by choice, not by
 * accident.
 */
export async function getConfigStringArray(key: string, fallback: string[]): Promise<string[]> {
  const v = (await loadAll()).get(key);
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  }
  if (typeof v === 'string') {
    return v
      .split(/[\s,;]+/)
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
  }
  return fallback;
}

/** Test-only cache reset. */
export function __resetConfigForTests(): void {
  cache = null;
  cachedAt = 0;
  inflight = null;
}
