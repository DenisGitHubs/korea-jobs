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

/** Test-only cache reset. */
export function __resetConfigForTests(): void {
  cache = null;
  cachedAt = 0;
  inflight = null;
}
