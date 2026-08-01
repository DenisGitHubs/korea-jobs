// lib/korea/core/acq-source.ts
//
// THE GATE for the acquisition label (users.acq_source). One module, used by BOTH entry
// paths — the Mini App auth upsert (core/context.ts) and the bot `/start` (bot/webhook.ts) —
// so what counts as a valid label can never differ between them.
//
// WHY A GATE AT ALL (2026-08-02, legal review)
// `parseStartParam` only decides the SHAPE of a label; it cannot decide its MEANING. Two holes
// follow from that, and the second is the serious one:
//
//   1. Anyone can set the label. `startapp` is just a URL tail: a stranger may open
//      t.me/korea_rabota_bot/app?startapp=s_ivan_petrov_seoul and put an arbitrary string into
//      their own row — a string that, by design, SURVIVES account erasure (the label is kept for
//      statistics). Free text that outlives deletion is exactly what must not exist.
//   2. A label could describe the PERSON instead of the channel (`s_uzbeki`, `ads_nelegaly`).
//      Nationality / migration status are a special category of personal data: storing them
//      needs a separate legal basis and its own consent, which we neither ask for nor have.
//
// The fix is an ALLOW-LIST, not a smarter regex: a label is recorded ONLY if it appears in the
// approved list in `config.acq_sources_allowed`. Anything else resolves to NULL — the person
// enters normally, we simply learn nothing about where they came from. That inverts the
// question from "is this string dangerous?" (unanswerable) to "did we approve this string?"
// (answerable, and answered by a human before the campaign starts).
//
// FAIL-CLOSED. No key, an empty list, a list whose every entry is malformed -> NOTHING is ever
// stored. A forgotten setup then costs statistics, never a legal exposure; the opposite default
// would mean the very hole above stays open for exactly as long as nobody notices. To keep the
// forgetting VISIBLE, /stats prints the effective list plus a count of labels that missed it.
//
// NORMALIZATION IS SHARED, NOT RESTATED. Both the incoming label and every list entry go
// through `normalizeAcqSource` — the same lowercase + dash-to-underscore folding the parser
// applies — so `ADS-RU1` in the ad cabinet and `ads_ru1` in the list are the same thing. Any
// second implementation here would drift; the owner would add a label and it would not work.
//
// NO RAW VALUES ANYWHERE. A rejected label is third-party input: it is not written to the DB,
// not echoed to /stats and not put into a log line. We only COUNT rejections (per day, in
// acq_rejects), which is enough for the owner to notice his own typo.

import { getConfigStringArray } from '../config.js';
import { normalizeAcqSource } from './start-param.js';
import type { getSql } from './db.js';

type Sql = ReturnType<typeof getSql>;

/** Config key holding the approved labels (jsonb array of strings). Change without a deploy. */
export const ACQ_ALLOWLIST_KEY = 'acq_sources_allowed';

/** How many labels /stats will echo back — a guard against an over-long list, not a policy. */
export const ACQ_ALLOWLIST_ECHO_MAX = 20;

export interface AcqDecision {
  /** The label to store, or null when nothing may be stored. */
  source: string | null;
  /**
   * True when a WELL-FORMED label arrived but is not on the list: the owner mistyped it in the
   * ad cabinet / forgot to add it, or a stranger invented one. Counted, never stored.
   */
  rejected: boolean;
}

/**
 * The approved labels, canonicalized exactly like an incoming one and de-duplicated, in the
 * order the owner wrote them (so /stats reads back the way his list looks).
 *
 * Entries are forgiving about how they were pasted:
 *   * `ADS_RU1` -> `ads_ru1`, `ads_ru-1` -> `ads_ru_1` (the parser's own folding, no more: the
 *     prefix itself still needs its underscore, so `ads-ru1` is junk here exactly as it is in a
 *     link — inventing a looser rule here would accept list entries no visitor can ever match);
 *   * a whole link (`https://t.me/korea_rabota_bot/app?startapp=ads_ru1`) -> `ads_ru1`, because
 *     copying the link he just pasted into the cabinet is the likeliest thing to happen;
 *   * anything that still is not a legal label (Cyrillic, no prefix, too long) is DROPPED — and
 *     its absence from the /stats echo is how the owner sees that it did not take.
 *
 * NEVER THROWS. A config read that fails (DB blip) yields an empty list, i.e. "nothing is
 * approved" — the same fail-closed answer as "the owner has not set it up". A person who tapped
 * a PAID ad must get into the app even when our bookkeeping is having a bad minute.
 */
export async function getAllowedAcqSources(): Promise<string[]> {
  let raw: string[];
  try {
    raw = await getConfigStringArray(ACQ_ALLOWLIST_KEY, []);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      '[acq] allow-list read failed, treating as empty:',
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
  const out: string[] = [];
  for (const entry of raw) {
    // A pasted URL/query keeps only what follows the last '=' (…?startapp=ads_ru1 -> ads_ru1).
    const tail = entry.includes('=') ? entry.slice(entry.lastIndexOf('=') + 1) : entry;
    const label = normalizeAcqSource(tail);
    if (label && !out.includes(label)) out.push(label);
  }
  return out;
}

/**
 * Decide what (if anything) may be written to users.acq_source for this start_param.
 *
 * Cheap by construction: the shape check is pure and runs first, so a visit WITHOUT a label
 * (the overwhelming majority, including every referral and vacancy-share link) never touches
 * the config at all — no extra DB round-trip on the hot auth path. Only a link that already
 * looks like a campaign label pays for the (60-second cached) allow-list read, which is also
 * why a newly added label starts counting within a minute and without a deploy.
 */
export async function resolveAcqSource(raw: string | null | undefined): Promise<AcqDecision> {
  const label = normalizeAcqSource(raw);
  if (!label) return { source: null, rejected: false }; // no label at all — nothing to decide
  const allowed = await getAllowedAcqSources();
  return allowed.includes(label)
    ? { source: label, rejected: false }
    : { source: null, rejected: true };
}

/**
 * Count ONE rejected label (per Seoul day). Best-effort in the strongest sense: a missing table,
 * a DB blip or anything else is swallowed — a person who tapped a PAID ad must get into the app
 * even if bookkeeping is broken.
 *
 * The row carries a date and a number and nothing else: no user, no value, no text. That is what
 * makes it safe to keep — there is nothing in it to leak or to erase on request. The owner reads
 * it in /stats as «меток мимо списка за неделю: N», which is exactly the signal «ты опечатался
 * в кабинете или забыл добавить метку в список», without ever showing a stranger's string.
 */
export async function noteAcqRejectBestEffort(sql: Sql): Promise<void> {
  try {
    await sql`
      insert into acq_rejects (day, n)
      values ((now() at time zone 'Asia/Seoul')::date, 1)
      on conflict (day) do update set n = acq_rejects.n + 1`;
  } catch (err) {
    // The message may quote the statement, never the label (it is not interpolated into it).
    // eslint-disable-next-line no-console
    console.error(
      '[acq] reject counter failed (table missing?):',
      err instanceof Error ? err.message : String(err),
    );
  }
}
