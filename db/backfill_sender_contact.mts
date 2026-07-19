// db/backfill_sender_contact.mts — one-off, IDEMPOTENT backfill for the sender-username contact
// fallback (owner rule 2026-07-19, mirror of lib/korea/parser/run.ts).
//
// Why: many live vacancies were parsed with NO contact in the text ("подробности в ЛС") and now
// show the "Открыть в канале" fallback instead of a reachable contact. The collector stores the
// poster's @username (raw_messages.sender_username); a LIVE user who posted publicly IS reachable
// at that handle. The parser now fills contact_raw='@'+sender_username / contact_kind='telegram'
// for NEW rows; this walks the EXISTING active corpus and does the same, so already-published
// cards get the contact too.
//
// Guards mirror the parser EXACTLY:
//   * only ACTIVE, non-duplicate vacancies whose contact_raw is empty (idempotent predicate);
//   * only rows whose raw_message is still alive and carries a non-empty sender_username;
//   * strip a leading '@', then SKIP bot authors (handle ends with 'bot', case-insensitive) —
//     a channel's bot does not answer DMs;
//   * the prospective content_hash (with the new contact) must not match takedowns or an
//     admin_hidden card — same moderation block-check the parser runs before insert.
//
// content_hash + contact_normalized are GENERATED columns → they recompute automatically on the
// UPDATE. content_hash has a PARTIAL UNIQUE index over active canonicals (uniq_vacancies_active_hash):
// if a row's NEW hash collides with an existing active canonical (same author+city+work_type+gender
// +dedup_extra), the UPDATE raises 23505 — we CATCH it, SKIP the row and count it (never merge two
// live cards). Nothing is deleted; only contact_raw/contact_kind are written.
//
// Run from the project root (tsx is a devDependency):
//   npx tsx db/backfill_sender_contact.mts
//
// Reads DATABASE_URL_UNPOOLED (fallback DATABASE_URL) from the local .env — never printed.
// Idempotent: the WHERE keeps re-runs from re-touching rows that already got a contact, and rows
// that hit a hash conflict stay empty (they are simply skipped again on the next run).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Pool } from '@neondatabase/serverless';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(ROOT, '.env');

function envVal(text: string, key: string): string | null {
  const m = text.match(new RegExp('^' + key + '=(.*)$', 'm'));
  return m ? m[1].trim() : null;
}

const envText = readFileSync(ENV_PATH, 'utf8');
const url = envVal(envText, 'DATABASE_URL_UNPOOLED') || envVal(envText, 'DATABASE_URL');
if (!url) {
  console.error('FATAL: no DATABASE_URL(_UNPOOLED) in .env');
  process.exit(1);
}

const pool = new Pool({ connectionString: url });
try {
  const v = await pool.query('select version() as v');
  console.log('connected:', String(v.rows[0].v).split(',')[0]);

  // Candidates: active, non-duplicate vacancies with an empty contact_raw whose raw source row is
  // still present and carries a sender_username. The bot guard + '@'-strip + emptiness are applied
  // in JS below so they mirror the parser's fallback byte-for-byte.
  const rows = (
    await pool.query<{ id: string; sender_username: string | null }>(
      `select v.id, r.sender_username
         from vacancies v
         join raw_messages r on r.id = v.raw_message_id
        where v.is_active
          and v.duplicate_of is null
          and (v.contact_raw is null or v.contact_raw = '')
          and v.raw_message_id is not null
          and r.sender_username is not null
          and btrim(r.sender_username) <> ''
        order by v.id`,
    )
  ).rows;

  let scanned = 0;
  let updated = 0;
  let skippedNoSender = 0;
  let skippedBot = 0;
  let skippedConflict = 0;
  let skippedNoop = 0;

  for (const row of rows) {
    scanned++;
    const handle = (row.sender_username ?? '').trim().replace(/^@+/, '');
    if (handle === '') {
      skippedNoSender++;
      continue;
    }
    if (handle.toLowerCase().endsWith('bot')) {
      skippedBot++;
      continue;
    }

    try {
      // The extra empty-contact predicate keeps the write doubly idempotent (concurrent-safe).
      // The generated content_hash / contact_normalized recompute here; a hash collision with an
      // existing active canonical raises 23505 (caught below).
      //
      // Moderation gate (007/Цензор, mirrors the parser's CTE block-check byte-for-byte): if the
      // PROSPECTIVE hash with the new contact matches a takedowns entry or an admin_hidden card,
      // the row is left contact-less — the backfill must never resurface content the admin/ToS
      // process removed. kj_content_hash args mirror the generated column exactly.
      const res = await pool.query(
        `update vacancies
            set contact_raw = $1, contact_kind = 'telegram'
          where id = $2::uuid
            and (contact_raw is null or contact_raw = '')
            and not exists (
              select 1 from takedowns t
              where t.content_hash = kj_content_hash($1, vacancies.city_id, vacancies.work_type,
                                                     vacancies.gender, vacancies.dedup_extra))
            and not exists (
              select 1 from vacancies h
              where h.admin_hidden
                and h.content_hash = kj_content_hash($1, vacancies.city_id, vacancies.work_type,
                                                     vacancies.gender, vacancies.dedup_extra))`,
        ['@' + handle, row.id],
      );
      if (res.rowCount === 1) updated++;
      else skippedNoop++; // already filled concurrently OR blocked by the moderation gate
    } catch (e) {
      // 23505 = unique_violation on uniq_vacancies_active_hash: the new hash matches another live
      // canonical (same author+city+work_type+gender+dedup_extra). Leave this card contact-less to
      // avoid gluing two live vacancies onto one dedup key.
      if (e && (e as { code?: string }).code === '23505') {
        skippedConflict++;
        continue;
      }
      throw e;
    }
  }

  console.log(
    `BACKFILL DONE: scanned=${scanned} updated=${updated} ` +
      `skipped_no_sender=${skippedNoSender} skipped_bot=${skippedBot} ` +
      `skipped_hash_conflict=${skippedConflict} skipped_noop=${skippedNoop}`,
  );
} catch (e) {
  console.error('BACKFILL FAILED:', e && (e as Error).message ? (e as Error).message : e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
