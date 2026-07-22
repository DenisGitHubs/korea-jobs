// lib/korea/parser/run.ts
//
// The "brain": pull pending raw_messages, ask Claude to extract structured vacancies
// (strict JSON schema with the city list as a closed enum), then upsert into
// vacancies with dedup (partial-unique content_hash). Idempotent + resumable: each
// raw row is moved out of 'pending' as it is handled, so a partial run is safe and
// the next tick continues.
//
// SECURITY (007 + Sanya §5.2): message text is DATA. We use plain structured output
// (no tools the model could be steered into); the system prompt tells the model to
// ignore any instructions embedded in a message. Never log message text or contacts.
//
// Model: config `parser_model` alias (default 'haiku' = claude-haiku-4-5, per the
// approved plan — cheap for high volume). Bump to 'sonnet'/'opus' via config, no code
// change. Model ids verified via the claude-api skill.

import Anthropic from '@anthropic-ai/sdk';
import { getSql } from '../core/db.js';
import { scrubContacts } from '../core/scrub.js';
import { truncateContacts } from '../core/contact-trim.js';
import { getConfigNumber, getConfigString, getConfigBool } from '../config.js';
import { textHash } from './texthash.js';
import { verdictHash, shouldCacheVerdict, lookupVerdictCache, touchVerdictCache, upsertVerdictCache } from './verdict-cache.js';
import { cleanForAi } from './text-clean.js';
import { extractJson } from './extract-json.js';
import { looksLikeSpam } from './spamfilter.js';
import { recordAiUsage } from '../ai-usage.js';
import { recordAiReject } from './reject-log.js';
import { pickCanonical, isLiveUserHandle, normalizeHandle } from './canonical.js';
import { buildCityMatcher, detectCitySlugs, detectRegionSlugs } from '../cities/detect.js';
import {
  buildSystemPrompt,
  GEO_RESOLVE_INSTRUCTION,
  PARSER_CLASSIFY_INSTRUCTION,
  readAiGeoFields,
  VISA_TYPES,
  PLACEMENT_FEES,
  WORK_TYPES,
  GENDERS,
  type CityRef,
  type ParsedVacancy,
  type VisaType,
  type PlacementFee,
  type WorkType,
} from './prompt.js';

const VISA_TYPE_SET = new Set<string>(VISA_TYPES);
const PLACEMENT_FEE_SET = new Set<string>(PLACEMENT_FEES);
const WORK_TYPE_SET = new Set<string>(WORK_TYPES);
const GENDER_SET = new Set<string>(GENDERS);
type Gender = (typeof GENDERS)[number];

/** Keep only known enum values the model may have returned (defense in depth). */
function cleanVisaTypes(v: unknown): VisaType[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is VisaType => typeof x === 'string' && VISA_TYPE_SET.has(x)))];
}
function cleanPlacementFee(v: unknown): PlacementFee {
  return typeof v === 'string' && PLACEMENT_FEE_SET.has(v) ? (v as PlacementFee) : 'unknown';
}
function cleanTriState(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}
// work_type / gender are the only model fields cast straight into SQL enums (::work_type,
// ::gender). Re-close them on the server so a MISSING key (the slim output omits null/empty
// fields — parser/prompt.ts) or a bad value can never (a) insert undefined, nor (b) throw out of
// the kj_content_hash CTE below. The prompt keeps both REQUIRED for a vacancy, so on the happy
// path these return the model's value unchanged — this is pure defense in depth.
function cleanWorkType(v: unknown): WorkType {
  return typeof v === 'string' && WORK_TYPE_SET.has(v) ? (v as WorkType) : 'other';
}
function cleanGender(v: unknown): Gender {
  return typeof v === 'string' && GENDER_SET.has(v) ? (v as Gender) : 'any';
}

// Confidence value stored for an AI-JUDGED reject/low_confidence row. DEFENSE IN DEPTH (Censor
// «остаток-3»): a row that REACHED the model — any verdict — is the FIRST, AI-judged copy and MUST
// stay distinguishable from a pre-AI cache-skip, which writes NO confidence (leaves it NULL). That
// non-NULL confidence is the EXACT discriminator raw/read.ts + admin/stats.ts + raw/reveal.ts use
// (`reject_reason='low_confidence' AND confidence IS NOT NULL`) to keep the AI-judged «Не проверено»
// row visible while hiding cached repeats. The whole «первая судимая ИИ копия» invariant hung on the
// model ALWAYS returning a number; if it ever omits confidence on an is_vacancy=true+low_confidence
// item, the naive `it.confidence ?? null` would write NULL and the judged row would silently vanish
// (indistinguishable from a cache-skip). So default a missing/non-finite confidence to 0 (still under
// parser_min_confidence, so the low_confidence branch stays self-consistent) — never NULL.
export function aiJudgedConfidence(confidence: unknown): number {
  return typeof confidence === 'number' && Number.isFinite(confidence) ? confidence : 0;
}

// Cheap, high-precision spam pre-filter — obvious non-jobs (crypto exchange, money-mule,
// leaflet gigs, emoji carpets) are the bulk of the raw stream. Rules + thresholds live in
// parser/spamfilter.ts (extracted so they are unit-testable); rows that match are marked
// reject_reason='spam_prefilter' so the pattern set stays tunable from data.

// In-batch canonical selection (pickCanonical) + the shared live-user/bot handle test live in
// parser/canonical.ts (pure, unit-tested — canonical.test.ts). postedMsFinite below stays LOCAL:
// it feeds the cross-time freshest-repost lift, whose null handling differs (null = "ignore this
// repost's date", NOT "sort it last" as postedMs/cmpEarliest do for canonical selection).
// Finite epoch ms of a raw row's posted_at, or null when missing/invalid. Used to pick the
// FRESHEST repost date to lift a canonical to — nulls are IGNORED (never treated as "now"), so a
// repost with no timestamp bumps the counter but never touches posted_at.
function postedMsFinite(r: Record<string, unknown>): number | null {
  const p = r.posted_at;
  if (p == null) return null;
  const t = new Date(p as string | Date).getTime();
  return Number.isNaN(t) ? null : t;
}

const MODEL_ALIASES: Record<string, string> = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-4-8',
};

/** One row for the geo_suggestions learning ledger (Part B): an unresolved model place-name
 *  (kind='city', norm='') or a decoded slang pair (kind='slang', norm=decoded). */
interface GeoSuggestion {
  kind: 'city' | 'slang';
  surface: string;
  norm: string;
}

/**
 * Best-effort upsert of AI-geo learning rows (owner /stats inspection). NEVER throws — a geo_suggestions
 * write must never break a parse (the table is a later migration, so a deploy-before-apply window just
 * logs and moves on). Counts hits per (kind, surface, norm) and refreshes last_seen. surface/norm are
 * already trimmed+capped by readAiGeoFields; norm='' is the null-region canon (matches the unique index).
 */
async function recordGeoSuggestions(sql: ReturnType<typeof getSql>, items: GeoSuggestion[]): Promise<void> {
  if (items.length === 0) return;
  try {
    for (const s of items) {
      await sql`
        insert into geo_suggestions (kind, surface, norm, n, last_seen)
        values (${s.kind}, ${s.surface}, ${s.norm}, 1, now())
        on conflict (kind, surface, norm)
          do update set n = geo_suggestions.n + 1, last_seen = now()`;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[parser] geo_suggestions write skipped:', err instanceof Error ? err.message : String(err));
  }
}

export interface ParseResult {
  processed: number;
  vacancies: number;
}

export async function runParse(): Promise<ParseResult> {
  const sql = getSql();

  const batchSize = await getConfigNumber('parser_batch_size', 20);
  const minConfidence = await getConfigNumber('parser_min_confidence', 0.6);
  const modelAlias = await getConfigString('parser_model', 'haiku');
  const model = MODEL_ALIASES[modelAlias] ?? modelAlias;

  const maxAgeDays = await getConfigNumber('parser_max_age_days', 7);

  // Repost "bump" cooldown (owner rule 2026-07-19): a repost lifts the canonical's posted_at
  // (the feed sorts posted_at desc) and REVIVES an expired card — but the lift only happens when
  // the fresh copy is newer than the canonical by MORE than this many hours, so a text reposted
  // dozens of times can't glue itself to the top. Read with a default; the key is NOT seeded here.
  const bumpMinHours = await getConfigNumber('repost_bump_min_hours', 12);

  // Reject journal (owner rule 2026-07-20): count every AI-verdict reject by day+reason always, and
  // — only while this flag is on — also keep the FULL original text for a day so the owner can look
  // at what the AI discards (see parser/reject-log.ts). Read ONCE per batch; key is NOT seeded here
  // (owner flips it via the orchestrator after the migration is applied). Default off.
  const rejectLogEnabled = await getConfigBool('reject_log_enabled', false);

  // Owner rule: the AI never parses messages older than the freshness window
  // (default 1 week) — stale postings, and no tokens spent on them. Sweep any
  // stale 'pending' rows out of the queue first so they cannot accumulate.
  await sql`
    update raw_messages
    set status='skipped', processed_at=now(), reject_reason='too_old'
    where status='pending' and posted_at < now() - make_interval(days => ${maxAgeDays})`;

  // 1) Oldest pending raw messages WITHIN the freshness window. Join the source so we
  // can pass the channel title/notes to the model as a per-item city hint (source_hint).
  const pendingAll = await sql`
    select r.id, r.text, r.source_id, r.posted_at, r.sender_username, r.tg_message_id,
           s.title as source_title, s.notes as source_notes, s.username as source_username
    from raw_messages r
    left join sources s on s.id = r.source_id
    where r.status = 'pending'
      and r.posted_at >= now() - make_interval(days => ${maxAgeDays})
    order by r.fetched_at asc
    limit ${batchSize}`;
  if (pendingAll.length === 0) return { processed: 0, vacancies: 0 };

  // Drop obvious spam BEFORE the AI call — no tokens spent on crypto/exchange/leaflet junk
  // (~2/3 of the raw stream). Conservative matcher; borderline text still reaches the model.
  const spamIds: string[] = [];
  let pending = pendingAll.filter((r) => {
    if (looksLikeSpam((r.text as string | null) ?? '')) {
      spamIds.push(r.id as string);
      return false;
    }
    return true;
  });
  if (spamIds.length > 0) {
    await sql`update raw_messages set status='skipped', processed_at=now(),
              reject_reason='spam_prefilter' where id = any(${spamIds}::uuid[])`;
    // eslint-disable-next-line no-console
    console.log(`[parser] spam pre-filtered (no AI): ${spamIds.length}`);
  }
  if (pending.length === 0) return { processed: spamIds.length, vacancies: 0 };

  // 1b) PRE-AI EXACT-DUPLICATE dedup (owner rule 2026-07-19). The same posting is often reposted
  // BYTE-FOR-BYTE across several channels; collapse those copies BEFORE the model call so no
  // tokens are burned parsing the same text twice. Dedup is CROSS-SOURCE (by normalized text
  // hash GLOBALLY, not per source_id) — that is the whole point. text_hash is computed lazily
  // here (the reader never writes it); short texts hash to null and are never deduped (so e.g.
  // "Вопросы в ЛС" cannot collapse two different vacancies). See parser/texthash.ts.
  const textHashById = new Map<string, string | null>();
  for (const r of pending) textHashById.set(r.id as string, textHash((r.text as string | null) ?? null));

  // (a) CROSS-TIME: a pending row whose hash already belongs to a PARSED vacancy is a repost of
  // an already-published vacancy → skip it (reject_reason='duplicate', vacancy_id = the same
  // canonical), and bump that vacancy's repost_count / last_seen_at ("posted N times").
  const distinctHashes = [
    ...new Set(pending.map((r) => textHashById.get(r.id as string)).filter((h): h is string => h != null)),
  ];
  const priorVacancyByHash = new Map<string, string>();
  if (distinctHashes.length > 0) {
    const prior = await sql`
      select distinct on (text_hash) text_hash, vacancy_id
      from raw_messages
      where status = 'parsed' and vacancy_id is not null
        and text_hash = any(${distinctHashes}::text[])
      order by text_hash, processed_at asc`;
    for (const r of prior) priorVacancyByHash.set(r.text_hash as string, r.vacancy_id as string);
  }

  const crossSkips: {
    rawId: string;
    hash: string;
    vacancyId: string;
    postedMs: number | null;
    // Normalized live-user handle of THIS repost (null for a bot/anonymous copy). Used to backfill
    // a contact-less canonical below (owner rule 2026-07-20); bots never become a contact.
    senderHandle: string | null;
  }[] = [];
  pending = pending.filter((r) => {
    const h = textHashById.get(r.id as string);
    if (h != null && priorVacancyByHash.has(h)) {
      crossSkips.push({
        rawId: r.id as string,
        hash: h,
        vacancyId: priorVacancyByHash.get(h) as string,
        postedMs: postedMsFinite(r),
        senderHandle: isLiveUserHandle(r.sender_username) ? normalizeHandle(r.sender_username) : null,
      });
      return false;
    }
    return true;
  });
  for (const s of crossSkips) {
    await sql`
      update raw_messages
      set status='skipped', processed_at=now(), reject_reason='duplicate',
          vacancy_id=${s.vacancyId}::uuid, text_hash=${s.hash}
      where id=${s.rawId}::uuid`;
  }
  if (crossSkips.length > 0) {
    // Aggregate per canonical: how many reposts (N) and the FRESHEST repost date in this batch
    // (null-posted rows ignored → freshestMs stays null). One UPDATE per vacancy.
    const bump = new Map<
      string,
      { n: number; freshestMs: number | null; contactHandle: string | null; contactMs: number }
    >();
    for (const s of crossSkips) {
      const cur =
        bump.get(s.vacancyId) ??
        { n: 0, freshestMs: null, contactHandle: null, contactMs: Number.POSITIVE_INFINITY };
      cur.n += 1;
      if (s.postedMs != null && (cur.freshestMs == null || s.postedMs > cur.freshestMs)) {
        cur.freshestMs = s.postedMs;
      }
      // Contact-backfill candidate: the EARLIEST live-user repost's handle (a null posted_at sorts
      // LAST via +Infinity, mirroring pickCanonical; first live copy wins ties — deterministic since
      // crossSkips follows the fetched_at-asc pending order). A bot/anonymous copy is never taken.
      if (s.senderHandle != null) {
        const ms = s.postedMs ?? Number.POSITIVE_INFINITY;
        if (cur.contactHandle == null || ms < cur.contactMs) {
          cur.contactHandle = s.senderHandle;
          cur.contactMs = ms;
        }
      }
      bump.set(s.vacancyId, cur);
    }
    for (const [vacancyId, { n, freshestMs, contactHandle }] of bump) {
      // Owner rule 2026-07-19: a repost ALWAYS bumps the counter, refreshes last_seen_at and
      // REVIVES the card (is_active=true) — even one that had gone dark past its TTL. It only
      // LIFTS posted_at to the freshest repost date past the cooldown (freshest newer than the
      // canonical by > bumpMinHours), so a text reposted many times can't stick to the top.
      // A null freshest (all reposts un-timestamped) leaves posted_at alone; date/lift is the
      // ONLY thing the cooldown gates — counter/last_seen/is_active update unconditionally.
      const freshestIso = freshestMs != null ? new Date(freshestMs).toISOString() : null;
      // A vacancy the admin hid via rep:hide (admin_hidden) or one on the takedown list must NOT
      // be revived or lifted by a repost — that would override a human/ToS decision. The counter
      // and last_seen_at still advance (they don't distort the truth: the text WAS seen again).
      await sql`
        update vacancies set
          repost_count = repost_count + ${n},
          last_seen_at = now(),
          is_active = case
            when not vacancies.admin_hidden
              and not exists (select 1 from takedowns t where t.content_hash = vacancies.content_hash)
              then true
            else vacancies.is_active
          end,
          posted_at = case
            when vacancies.admin_hidden
              or exists (select 1 from takedowns t where t.content_hash = vacancies.content_hash)
              then vacancies.posted_at
            when ${freshestIso}::timestamptz is null then vacancies.posted_at
            when vacancies.posted_at is null then ${freshestIso}::timestamptz
            when ${freshestIso}::timestamptz > vacancies.posted_at + make_interval(hours => ${bumpMinHours})
              then ${freshestIso}::timestamptz
            else vacancies.posted_at
          end
        where id=${vacancyId}::uuid`;

      // CONTACT BACKFILL on repost (owner rule 2026-07-20). A contact-less canonical ("подробности
      // в ЛС", no @handle in the text) can be made reachable when a repost of it comes from a LIVE
      // Telegram user — surface that author as the telegram contact. Done as a SEPARATE UPDATE
      // AFTER the bump so a failure here can never drop the counter/revive above.
      //   Guards (in the WHERE, so they are atomic with the write):
      //     • only when the canonical's contact is empty/NULL  — never overwrite a real contact;
      //     • never on an admin_hidden or takedown canonical    — those content_hashes must stay
      //       frozen (a takedown is keyed BY content_hash; changing contact would recompute it and
      //       let the content escape the block). Such canonicals are also left dark by the bump.
      //   content_hash is GENERATED from contact_raw, so this write RECOMPUTES the canonical's hash.
      //   uniq_vacancies_active_hash (partial unique over active canonicals) can then raise 23505 if
      //   the new hash collides with ANOTHER live canonical → we swallow it and simply skip the
      //   backfill (card stays contact-less); the bump already committed. Text-hash dedup is
      //   unaffected (it never depends on contact), so future byte-identical reposts still collapse.
      if (contactHandle != null) {
        try {
          await sql`
            update vacancies set
              contact_raw = ${'@' + contactHandle},
              contact_kind = 'telegram'::contact_kind
            where id = ${vacancyId}::uuid
              and (vacancies.contact_raw is null or btrim(vacancies.contact_raw) = '')
              and not vacancies.admin_hidden
              and not exists (
                select 1 from takedowns t where t.content_hash = vacancies.content_hash)
              -- 007 (gate 20.07): also gate on the PROSPECTIVE hash — the recomputed identity
              -- (with the new contact) must not land ON a takedown/admin_hidden hash either,
              -- mirroring the insert-time block-check. Without this a clean card could mutate
              -- into a blocked identity, bypassing the insert gate (admin_hidden has no
              -- cleanup re-sweep, so such a collision would otherwise persist).
              and not exists (
                select 1 from takedowns t2
                where t2.content_hash = kj_content_hash(${'@' + contactHandle}, vacancies.city_id,
                        vacancies.work_type, vacancies.gender, vacancies.dedup_extra))
              and not exists (
                select 1 from vacancies h
                where h.admin_hidden
                  and h.content_hash = kj_content_hash(${'@' + contactHandle}, vacancies.city_id,
                        vacancies.work_type, vacancies.gender, vacancies.dedup_extra))`;
        } catch (err) {
          // Expected case: 23505 unique_violation on uniq_vacancies_active_hash (the recomputed
          // content_hash clashes with another active canonical). Any error here is non-fatal — the
          // canonical simply keeps its "открыть в канале" fallback. Never rethrow: it would abort
          // the remaining bumps and the AI parse for a best-effort enrichment.
          // eslint-disable-next-line no-console
          console.error(
            '[parser] contact backfill skipped (hash conflict/other):',
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[parser] cross-time duplicates (no AI): ${crossSkips.length}`);
  }

  // (b) IN-BATCH: among the survivors, group by hash and keep ONE canonical (earliest posted_at);
  // mark the rest skipped 'duplicate'. Short-text (null hash) rows are never grouped.
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const r of pending) {
    const h = textHashById.get(r.id as string);
    if (h == null) continue;
    const g = groups.get(h);
    if (g) g.push(r);
    else groups.set(h, [r]);
  }
  const dropInBatch = new Map<string, string>(); // rawId -> hash
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // Owner rule 2026-07-20: don't just keep the earliest copy — keep the one whose AUTHOR is a live
    // Telegram user (non-bot @username) so the published card can carry a real DM contact; fall back
    // to a bot/anonymous copy only when no copy has a live-user author. Earliest wins within that
    // class (pickCanonical). Every OTHER copy in the group is the in-batch duplicate.
    const canonId = pickCanonical(group).id as string;
    for (const r of group) {
      const rid = r.id as string;
      if (rid === canonId) continue;
      dropInBatch.set(rid, textHashById.get(rid) as string);
    }
  }
  if (dropInBatch.size > 0) {
    for (const [rawId, h] of dropInBatch) {
      await sql`
        update raw_messages
        set status='skipped', processed_at=now(), reject_reason='duplicate', text_hash=${h}
        where id=${rawId}::uuid`;
    }
    pending = pending.filter((r) => !dropInBatch.has(r.id as string));
    // eslint-disable-next-line no-console
    console.log(`[parser] in-batch duplicates (no AI): ${dropInBatch.size}`);
  }

  // 1c) VERDICT CACHE (owner rule 2026-07-21). After the free filters, HALF of what remains repeats a
  // message the AI already judged a reject — often ONE short spam/chit-chat line posted many times an hour
  // that the 40-char text_hash dedup deliberately ignores (short texts hash to null there). A SEPARATE,
  // floor-less FUZZY letter-skeleton hash (verdict-cache.ts — lowercase, letters only, so a copy that
  // mimics only a digit 8000→9000 or an emoji 🐠→🏝 still collapses onto the same family) lets us reuse the
  // PRIOR verdict without paying the model again: hash every survivor, fetch all matches in ONE select,
  // mark a hit skipped with the cached reject_reason (never sent to the AI), count the replay in the reject
  // journal (a reused reject still counts), and bump its cache row's n/last_seen. Best-effort — a cache
  // fault leaves the row for the model (nothing lost). Only genuine NON-vacancy rejects are ever cached
  // (see the write-back after the AI), so a hit is always a real reject verdict — never a vacancy or a
  // low_confidence "Не проверено" row. This hash is a DIFFERENT contour from raw_messages.text_hash
  // (vacancy dedup), so we intentionally do NOT touch text_hash on a cache-skip.
  const verdictHashById = new Map<string, string | null>();
  for (const r of pending) verdictHashById.set(r.id as string, verdictHash((r.text as string | null) ?? null));
  const cacheHashes = [
    ...new Set([...verdictHashById.values()].filter((h): h is string => h != null)),
  ];
  const cachedVerdict = await lookupVerdictCache(sql, cacheHashes);
  const cacheSkips: { rawId: string; hash: string; reason: string }[] = [];
  pending = pending.filter((r) => {
    const h = verdictHashById.get(r.id as string);
    if (h != null && cachedVerdict.has(h)) {
      cacheSkips.push({ rawId: r.id as string, hash: h, reason: cachedVerdict.get(h) as string });
      return false;
    }
    return true;
  });
  if (cacheSkips.length > 0) {
    for (const s of cacheSkips) {
      await sql`
        update raw_messages set status='skipped', processed_at=now(), reject_reason=${s.reason}
        where id=${s.rawId}::uuid`;
      // Reject journal parity (owner rule 2026-07-20): a cache replay of a genuine REJECT IS a real
      // AI-verdict reject being reused, so it MUST advance the day+reason counter exactly like a fresh
      // reject — the reject-log invariant is "every AI-verdict reject counted always", and these short
      // repeats are the single MOST common reject. logSample:false — count the replay but never re-store
      // the full text of a repeat (the first copy already sampled it). Best-effort (never throws). NOTE:
      // we do NOT write raw_messages.confidence on a cache replay — that NULL is exactly how /stats and
      // GET /api/raw separate a pre-AI skip from a real AI verdict (admin/stats.ts, raw/read.ts), so it
      // is left untouched.
      //   EXCLUDE 'low_confidence' (owner 2026-07-22, "остаток-3"): low_confidence IS cached now, but it
      //   is the visible «Не проверено» tab, NOT a discarded reject — it must never enter ai_reject_stats
      //   (reject-log.ts invariant: "never 'low_confidence' here"). A low_confidence cache replay is
      //   simply a silent pre-AI skip: no counter, no sample, no «Не проверено» row (its confidence stays
      //   NULL, so raw/read.ts hides it — only the AI-judged first copy, with a non-NULL confidence, shows).
      if (s.reason !== 'low_confidence') {
        await recordAiReject({
          reason: s.reason,
          confidence: null,
          postedAt: null,
          text: '',
          sourceNote: null,
          logSample: false,
        });
      }
    }
    // Bump n/last_seen once per DISTINCT hash we served from cache (best-effort).
    await touchVerdictCache(sql, [...new Set(cacheSkips.map((s) => s.hash))]);
    // eslint-disable-next-line no-console
    console.log(`[parser] verdict-cache hits (no AI): ${cacheSkips.length}`);
  }

  // Total skipped before the model = spam + cross-time dups + in-batch dups + verdict-cache hits. Only
  // UNIQUE, un-cached (or too-short-to-dedup) messages reach the AI below.
  const preAiSkipped = spamIds.length + crossSkips.length + dropInBatch.size + cacheSkips.length;
  if (pending.length === 0) return { processed: preAiSkipped, vacancies: 0 };

  // 2) Active cities. TWO views over the SAME rows (one query):
  //   • FULL set (all 167) → cityIdBySlug + the multi-city text matcher (cities/detect.ts). `aliases`
  //     (jsonb array of lowercased spellings) is pulled for the matcher; the NEW (non-canonical)
  //     cities MUST live here so the additive city_ids scan can tag them — owner rule: "новые города
  //     живут только в city_ids от словаря" (draft_seed.sql).
  //   • PROMPT set (canonical 31, sort_order < 1000) → the AI enum passed to buildSystemPrompt.
  // INVARIANT — the AI enum stays on the CANONICAL 31 (sort_order < 1000), NEVER the full 167:
  //   (a) city_id (the AI's single primary pick) is the ANCHOR of the dedup content_hash — widening
  //       the enum would silently change dedup granularity across the whole corpus; and
  //   (b) this system prompt is the SHARED, byte-identical cached prefix with ads/moderation.ts —
  //       BOTH derive the prompt list the SAME way (filter sort_order < 1000, `order by sort_order,
  //       slug`) so the two callers keep ONE cache entry. Keep both sides in lock-step.
  //   sort_order is NOT NULL (default 0) → this JS filter matches SQL `sort_order < 1000` exactly.
  //   New cities (sort_order 1000+) are reached only via detect.ts → city_ids; a future wave may add
  //   a conditional free-text city_norm to the enum.
  const cityRows = await sql`
    select id, slug, name, region_slug, aliases, sort_order from cities where is_active = true order by sort_order, slug`;
  const promptCityRows = cityRows.filter((r) => (r.sort_order as number) < 1000);
  const cities: CityRef[] = promptCityRows.map((r) => ({
    slug: r.slug as string,
    name: r.name as { ru: string; ko: string; en: string },
    region_slug: (r.region_slug as string | null) ?? null,
  }));
  const regionSlugs = [...new Set(promptCityRows.map((r) => r.region_slug).filter(Boolean))] as string[];
  // FULL slug→id map (all 167): resolves BOTH the AI's canonical pick AND detect.ts's new-city slugs.
  const cityIdBySlug = new Map<string, string>(cityRows.map((r) => [r.slug as string, r.id as string]));
  // FULL city id→region_slug map (all 167): a row's region set includes the regions of its cities
  // (regions wave, Part A). NULL region_slugs are skipped (every seed city has one, so this is rare).
  const regionSlugByCityId = new Map<string, string>();
  for (const r of cityRows) {
    const rs = r.region_slug as string | null;
    if (rs) regionSlugByCityId.set(r.id as string, rs);
  }
  // Compiled ONCE over the FULL set, reused for every row below (the regexes are shared → cheap per message).
  const cityMatcher = buildCityMatcher(
    cityRows.map((r) => ({ slug: r.slug as string, aliases: r.aliases })),
  );
  // region is guided by the prompt (not a schema enum), so re-close the set on the server to the SAME
  // canonical regions the prompt lists (the AI can only echo one of those): unknown region -> null.
  const regionSlugSet = new Set<string>(regionSlugs);

  // MULTI-GEO precompute (regions wave): for EVERY pending row, the DICTIONARY-detected city slugs +
  // region slugs from the text + the source hint (title/@username/notes). Computed ONCE here and reused
  // twice: (a) to set need_geo:1 on an item where the dictionary found NOTHING (conditional AI-geo,
  // Part B), and (b) to build city_ids / region_slugs in the apply loop. The @username joins the hint
  // with underscores rewritten to spaces so a handle like "korea_daegu_jobs" -> "korea daegu jobs"
  // lets a city/region alias match on a WORD boundary (owner rule 2026-07-21); a glued "workansan"
  // stays boundary-safe. detect passes the hint as CONTEXT too (homonym disambiguation).
  const rowGeo = pending.map((r) => {
    const srcTitle = ((r.source_title as string | null) ?? '').trim();
    const srcUsername = ((r.source_username as string | null) ?? '').replace(/_/g, ' ').trim();
    const srcNotes = ((r.source_notes as string | null) ?? '').trim();
    const srcHint = [srcTitle, srcUsername, srcNotes].filter(Boolean).join(' — ');
    const text = (r.text as string | null) ?? '';
    const citySlugs = [
      ...new Set([
        ...detectCitySlugs(text, cityMatcher, { hintText: srcHint }),
        ...detectCitySlugs(srcHint, cityMatcher),
      ]),
    ];
    const detRegions = [
      ...new Set([...detectRegionSlugs(text, srcHint), ...detectRegionSlugs(srcHint)]),
    ];
    return { srcHint, citySlugs, detRegions };
  });

  // 3) Prompt + input. strict structured outputs can't compile our schema, so the required
  // JSON shape + enums live in the system prompt; every field is re-validated server-side.
  const system = buildSystemPrompt(cities, regionSlugs);
  // Batch-local SHORT ids ('0'..'N-1') instead of the 36-char raw uuid. The id is pure echo
  // routing — the model copies it back verbatim and we map replies to rows by it — so a 1-char
  // token carries the SAME meaning as a uuid while saving ~10 input tokens per message. The
  // `pending` array IS the server-side idx->rawId map (pending[idx].id === rawId); dedup and the
  // error/skip paths key on rawId (row.id), NOT this id, so they are unaffected.
  const inputItems = pending.map((r, i) => {
    const title = ((r.source_title as string | null) ?? '').trim();
    const notes = ((r.source_notes as string | null) ?? '').trim();
    const sourceHint = [title, notes].filter(Boolean).join(' — ');
    // cleanForAi collapses decorative emoji noise for the MODEL INPUT ONLY (fewer tokens). The
    // ORIGINAL r.text still drives text_hash (above), description and every content hash below, so
    // this can never move a dedup bucket. See parser/text-clean.ts.
    const item: { id: string; text: string; source_hint?: string; need_geo?: 1 } = {
      id: String(i),
      text: cleanForAi((r.text as string | null) ?? ''),
    };
    if (sourceHint) item.source_hint = sourceHint;
    // need_geo:1 ONLY when the dictionary found NEITHER a city NOR a region for this row (in text or
    // hint). Then — and only then — the model is asked to resolve the place from context/slang (Part B).
    if (rowGeo[i]!.citySlugs.length === 0 && rowGeo[i]!.detRegions.length === 0) item.need_geo = 1;
    return item;
  });

  // 4) One call for the whole batch. The required JSON shape is specified in the system
  // prompt (no output_config: strict structured outputs can't compile our schema); we
  // extract + parse the JSON object from the reply and re-validate everything server-side.
  let items: ParsedVacancy[] = [];
  try {
    // new Anthropic() is INSIDE the try so a missing/broken ANTHROPIC_API_KEY (the
    // constructor throws when it can't resolve a key) degrades softly — the batch is
    // left 'pending' for the next tick — instead of throwing out of runParse.
    const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
    const resp = await client.messages.create({
      model,
      max_tokens: 16000,
      // TWO system blocks (regions wave, Part B):
      //   [0] the STABLE cacheable prefix (city list + extraction contract, ≥4096 tokens so haiku
      //       actually caches it — under the min the breakpoint is a silent no-op). It is BYTE-IDENTICAL
      //       to ads/moderation.ts's block[0] (same buildSystemPrompt + same cities/regions derivation),
      //       so the two callers SHARE this one cache entry — do NOT change what goes into it.
      //   [1] the STATIC parser-only tail (Part B geo-resolution + the classification refinements). It is
      //       placed AFTER block[0] so it never changes the shared prefix (Skills/Рома/ai-cost-haiku), and
      //       gets its OWN cache_control: block[0]'s cached prefix is a strict PREFIX of block[1]'s, so
      //       block[0] stays shared with moderation while block[1] (parser-only, static) warms once per
      //       wave. ttl:'1h' on both keeps them warm across a whole cron sweep. GEO_RESOLVE_INSTRUCTION +
      //       PARSER_CLASSIFY_INSTRUCTION are BOTH static parser-only text, joined into this one block so
      //       there is still just a single parser-tail cache breakpoint. The per-batch messages are
      //       volatile and come after.
      system: [
        { type: 'text', text: system, cache_control: { type: 'ephemeral', ttl: '1h' } },
        {
          type: 'text',
          text: GEO_RESOLVE_INSTRUCTION + '\n\n' + PARSER_CLASSIFY_INSTRUCTION,
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
      messages: [{ role: 'user', content: JSON.stringify({ messages: inputItems }) }],
    } as Anthropic.MessageCreateParamsNonStreaming);

    // Weigh the tokens (best-effort, never throws). batch_size = messages actually sent to the
    // model this call. Field names verified against the SDK Usage type (cache_creation_input_tokens
    // / cache_read_input_tokens). See lib/korea/ai-usage.ts + draft_0015_ai_usage.sql.
    await recordAiUsage('parser', model, resp.usage, inputItems.length);

    const textBlock = resp.content.find((b) => b.type === 'text');
    if (textBlock && 'text' in textBlock) {
      const parsed = extractJson(textBlock.text) as { items?: ParsedVacancy[] };
      items = Array.isArray(parsed.items) ? parsed.items : [];
    }
  } catch (err) {
    // Model/transport fault: leave the batch 'pending' for the next tick. Log the
    // error MESSAGE (not the payload) — a silent swallow made a bad schema/request
    // impossible to diagnose in prod.
    // eslint-disable-next-line no-console
    console.error('[parser] extraction call failed:', err instanceof Error ? err.message : String(err));
    return { processed: 0, vacancies: 0 };
  }

  // Map replies by their echoed id. String(it.id) guards a model that returns the index as a
  // JSON number (0) instead of the string ("0") we sent.
  const byId = new Map<string, ParsedVacancy>(items.map((it) => [String(it.id), it]));
  let vacancies = 0;

  // 5) Apply each result; move every raw row out of 'pending'. The reply for pending[idx] is
  // byId.get(String(idx)) — the short id we sent in inputItems; all persistence keys on rawId.
  for (let idx = 0; idx < pending.length; idx++) {
    const row = pending[idx]!;
    const rawId = row.id as string;
    const it = byId.get(String(idx));
    // Persist the text hash on every row we touch so future ticks can dedup against it
    // (esp. the 'parsed' canonical); null for short texts is a harmless no-op write.
    const hash = textHashById.get(rawId) ?? null;

    if (!it) {
      await sql`update raw_messages set status='error', processed_at=now(), error='no_parser_output', text_hash=${hash} where id=${rawId}::uuid`;
      continue;
    }

    if (!it.is_vacancy || (it.confidence ?? 0) < minConfidence) {
      // Persist WHY + confidence so the corpus is tunable (which reasons over/under-fire).
      const rejectReason = it.reject_reason ?? (it.is_vacancy ? 'low_confidence' : 'not_vacancy');
      await sql`
        update raw_messages
        set status='skipped', processed_at=now(),
            reject_reason=${rejectReason},
            confidence=${aiJudgedConfidence(it.confidence)}, text_hash=${hash}
        where id=${rawId}::uuid`;
      // Reject journal (owner rule 2026-07-20), best-effort. Count + (when enabled) sample the FULL
      // original text of AI-verdict rejects. EXCLUDE 'low_confidence' — those are the visible "Не
      // проверено" tab, not discarded — (spam_prefilter never reaches the AI at all). Never throws.
      if (rejectReason !== 'low_confidence') {
        await recordAiReject({
          reason: rejectReason,
          confidence: it.confidence ?? null,
          postedAt: (row.posted_at as Date | string | null) ?? null,
          text: (row.text as string | null) ?? '',
          sourceNote: (row.source_username as string | null) ?? null,
          logSample: rejectLogEnabled,
        });
      }
      // VERDICT CACHE write-back (owner rule 2026-07-21; low_confidence added 2026-07-22, "остаток-3").
      // Remember this verdict so an EXACT repeat skips the model next time (see the pre-AI lookup at 1c).
      // Cache BOTH genuine rejects AND low_confidence «Не проверено» — this is the reject branch, so the
      // row was NOT kept as a published vacancy; caching low_confidence is exactly what collapses a
      // repeated «Не проверено» line ("Возьму пару человек" ×25) to ONE AI judgment + one visible row
      // (the repeats become pre-AI cache skips that raw/read.ts hides). This write is OUTSIDE the
      // low_confidence guard above (that guard is only about the reject JOURNAL, which must NOT count
      // low_confidence). shouldCacheVerdict re-asserts the ONE invariant — never cache a PUBLISHED
      // vacancy (is_vacancy AND confidence >= min); that can never happen in this branch, so it is pure
      // defense in depth. Best-effort. verdictHashById keyed the row before the AI, so short texts (null
      // hash) are simply not cached.
      const keptAsVacancy = it.is_vacancy === true && (it.confidence ?? 0) >= minConfidence;
      if (shouldCacheVerdict(keptAsVacancy, rejectReason)) {
        const vh = verdictHashById.get(rawId) ?? null;
        if (vh) await upsertVerdictCache(sql, vh, rejectReason);
      }
      continue;
    }

    const cityId = it.city_slug ? cityIdBySlug.get(it.city_slug) ?? null : null;
    const regionSlug = it.region_slug && regionSlugSet.has(it.region_slug) ? it.region_slug : null;
    const workType = cleanWorkType(it.work_type);
    const gender = cleanGender(it.gender);
    const visaTypes = cleanVisaTypes(it.visa_types);
    const placementFee = cleanPlacementFee(it.placement_fee);
    const hasHousing = cleanTriState(it.has_housing);
    const hasMeals = cleanTriState(it.has_meals);
    // contact_raw may now hold SEVERAL contacts joined by " · " (owner rule 2026-07-19: show
    // every contact, not just the first). Cap the whole string at 300 chars so a pathological
    // list can't blow up the row / content_hash input — but on a CONTACT boundary, never
    // mid-number (truncateContacts, shared with ads/input.ts). The SAME value feeds the
    // block-check hash below AND the insert so the prospective content_hash matches what is
    // stored (and matches contact_normalized, which keys on the FIRST contact — see 0014).
    let contactRaw = it.contact_raw ? truncateContacts(it.contact_raw, 300) : null;
    let contactKind = it.contact_kind ?? null;

    // SENDER-USERNAME FALLBACK (owner rule 2026-07-19). Many real postings say only
    // "подробности в ЛС" with no contact in the TEXT — but the collector stores the poster's
    // @username (raw_messages.sender_username, written by ingest/handler.ts). A LIVE user who
    // posted publicly IS reachable at that handle, so surface it as the telegram contact instead
    // of leaving the card contact-less ("Открыть в канале"). Fires ONLY when the AI extracted no
    // contact — it never overrides a real one the model found in the text.
    // Guards: (a) skip bot authors (handle ends with 'bot', case-insensitive) — a channel's bot
    // does not answer DMs, so those keep the channel fallback; (b) this SAME value feeds the
    // block-check hash AND the insert below (one value → prospective content_hash == stored,
    // invariant held); (c) description is untouched (scrub stays as-is). Dedup: the fallback
    // fires ONLY on no-contact rows, which is EXACTLY where the AI fills dedup_extra — so two
    // different offers from one author stay distinct on dedup_extra, and it also REMOVES the old
    // cross-author 'nocontact' collision (different authors used to share the 'nocontact' bucket).
    const hasAiContact = contactRaw != null && contactRaw.trim() !== '';
    if (!hasAiContact && isLiveUserHandle(row.sender_username)) {
      contactRaw = '@' + normalizeHandle(row.sender_username);
      contactKind = 'telegram';
    }
    // Owner rule (2026-07-15): description = the FULL original message text minus contacts
    // (the AI no longer summarizes it, and no longer interprets salary — salary now lives
    // inside this text). scrubContacts strips phones/@handles/t.me·wa.me·kakao links.
    const description = scrubContacts((row.text as string | null) ?? null);

    // PERSISTED original-post link (owner rule 2026-07-22, draft_0023). Same formula the read-side
    // detail-CASE used — https://t.me/<source username>/<tg_message_id> — but computed & STORED here so
    // it survives the 24h raw_messages purge (the join was going NULL once the raw was deleted, killing
    // the "открыть в канале" fallback and creating dead-end cards). No contact/city gate here (that stays
    // a DISPLAY decision in read.ts): we save the link whenever BOTH the channel username and the message
    // id exist, else NULL. tg_message_id is bigint (neon returns it as string|number) -> stringify safely.
    const srcUsername = ((row.source_username as string | null) ?? '').trim();
    const tgMessageId = row.tg_message_id;
    const sourcePostUrl =
      srcUsername !== '' && tgMessageId != null && String(tgMessageId).trim() !== ''
        ? `https://t.me/${srcUsername}/${String(tgMessageId).trim()}`
        : null;

    // MULTI-CITY (multi-city plan): city_ids = the DISTINCT union of the AI's primary city (cityId) and
    // every city the DICTIONARY named in the ORIGINAL text + the source hint (rowGeo[idx], precomputed
    // above from the raw text and the title/@username/notes hint). city_id stays the PRIMARY city.
    const geo = rowGeo[idx]!;
    const cityIdSet = new Set<string>();
    if (cityId) cityIdSet.add(cityId);
    for (const slug of geo.citySlugs) {
      const id = cityIdBySlug.get(slug);
      if (id) cityIdSet.add(id);
    }

    // MULTI-REGION (regions wave, Part A): region_slugs = the regions of every city in city_ids ∪ every
    // region the dictionary named in the text/hint ∪ the singular AI region pick (regionSlug). Built
    // additively; region_slug (the AI's single pick) stays the PRIMARY region column.
    const regionSet = new Set<string>();
    for (const rs of geo.detRegions) regionSet.add(rs);
    if (regionSlug) regionSet.add(regionSlug);

    // CONDITIONAL AI-GEO (Part B, owner rule): only for a need_geo item the model MAY return city_norm /
    // region_norm / city_slang. Resolve city_norm/region_norm through the FULL matcher (167 + provinces)
    // into city_ids / region_slugs — NEVER into city_id (the dedup anchor stays the dictionary/AI pick).
    // Unresolved names + every decoded slang pair are logged to geo_suggestions (best-effort, below).
    //
    // SERVER GATE (defense in depth, like every other model field): the Part-B geo keys are honoured ONLY
    // for a row we actually flagged need_geo:1 — i.e. the dictionary found NEITHER a city NOR a region
    // (the SAME condition inputItems used to set need_geo). If the model volunteers city_norm/region_norm/
    // city_slang for a row that DID resolve from the dictionary, we ignore them, so a stray field can
    // never pollute (or override) a dictionary-resolved row's geo.
    const needGeo = geo.citySlugs.length === 0 && geo.detRegions.length === 0;
    const suggestions: GeoSuggestion[] = [];
    const aiGeo = needGeo ? readAiGeoFields(it) : { cityNorm: null, regionNorm: null, slang: [] };
    if (aiGeo.cityNorm) {
      const slugs = detectCitySlugs(aiGeo.cityNorm, cityMatcher);
      if (slugs.length > 0) {
        for (const s of slugs) {
          const id = cityIdBySlug.get(s);
          if (id) cityIdSet.add(id);
        }
      } else {
        suggestions.push({ kind: 'city', surface: aiGeo.cityNorm, norm: '' }); // unknown city -> learn
      }
    }
    if (aiGeo.regionNorm) {
      const regions = detectRegionSlugs(aiGeo.regionNorm);
      if (regions.length > 0) for (const rs of regions) regionSet.add(rs);
      else suggestions.push({ kind: 'city', surface: aiGeo.regionNorm, norm: '' }); // unknown region -> learn
    }
    for (const p of aiGeo.slang) suggestions.push({ kind: 'slang', surface: p.slang, norm: p.norm });

    const cityIds = [...cityIdSet];
    // regions of the resolved cities are folded in AFTER AI-geo (city_norm may have added a city).
    for (const id of cityIdSet) {
      const rs = regionSlugByCityId.get(id);
      if (rs) regionSet.add(rs);
    }
    const cityRegionSlugs = [...regionSet];

    // Takedown / admin-hidden gate (007 CRIT + owner-hide guard). Never resurrect content taken
    // down for a ToS 5.2(i) contact violation, NOR content the admin manually hid via rep:hide.
    // The prospective content_hash is computed via kj_content_hash (an exact mirror of the
    // generated column) since the real hash only exists after insert. A byte-identical repost of a
    // hidden vacancy is already caught upstream by the text_hash cross-time path; THIS also blocks
    // a *reworded* repost whose content_hash matches an admin_hidden canonical — that canonical is
    // is_active=false, so it is NOT in the partial-unique index and an insert would otherwise
    // create a NEW live copy, silently overriding the owner's hide. One round-trip, hash computed
    // once in the CTE; takedown wins the reason when both match (union order + limit 1).
    const blocked = await sql`
      with h as (
        select kj_content_hash(
          ${contactRaw}, ${cityId}::uuid, ${workType}::work_type,
          ${gender}::gender, ${it.dedup_extra ?? null}) as content_hash)
      select 'takedown' as reason from takedowns, h where takedowns.content_hash = h.content_hash
      union all
      select 'admin_hidden' from vacancies, h
        where vacancies.content_hash = h.content_hash and vacancies.admin_hidden
      limit 1`;
    if (blocked.length > 0) {
      const reason = blocked[0]!.reason as string;
      await sql`
        update raw_messages set status='skipped', processed_at=now(), reject_reason=${reason}, text_hash=${hash}
        where id=${rawId}::uuid`;
      continue;
    }

    // Insert; on dedup conflict bump the canonical instead. (xmax = 0) marks a fresh insert.
    let upserted: Record<string, unknown>[];
    try {
      // Salary columns are intentionally omitted: the model no longer interprets salary
      // (it confused currency/units — "7000 руб", "2300 тыс вон"), so salary_text/min/max/
      // period all take their NULL default and salary_currency keeps its NOT NULL 'KRW'
      // default (never surfaced in the feed). The number stays inside description.
      // title/lang are written NULL (owner rule 2026-07-20): the model no longer returns them
      // (parser/prompt.ts dropped both from the contract). The columns stay in the DB untouched
      // — both are nullable (vacancies.lang carries no default), so NULL is valid. The feed reads
      // description, and the complaint snippet (reports/rw.ts) already falls back title -> description.
      upserted = await sql`
        insert into vacancies (
          city_id, city_ids, region_slug, region_slugs, work_type, gender, lang,
          title, description, employer,
          contact_raw, contact_kind,
          visa_types, placement_fee, has_housing, has_meals,
          source_id, raw_message_id, posted_at, dedup_extra, source_post_url
        ) values (
          ${cityId}::uuid, ${cityIds}::uuid[], ${regionSlug}, ${cityRegionSlugs}::text[], ${workType}::work_type, ${gender}::gender, ${null},
          ${null}, ${description}, ${it.employer ?? null},
          ${contactRaw}, ${contactKind}::contact_kind,
          ${visaTypes}::visa_type[], ${placementFee}::placement_fee, ${hasHousing}, ${hasMeals},
          ${row.source_id}::uuid, ${rawId}::uuid, ${row.posted_at ?? null}, ${it.dedup_extra ?? null}, ${sourcePostUrl}
        )
        on conflict (content_hash) where is_active and duplicate_of is null
        do update set
          repost_count = vacancies.repost_count + 1,
          last_seen_at = now(),
          -- MULTI-CITY additive enrichment: a repost may name a city the first sighting missed.
          -- UNION the existing and incoming city sets (DISTINCT); never shrink. city_id (PRIMARY) stays.
          city_ids = (
            select coalesce(array_agg(distinct e), '{}'::uuid[])
            from unnest(vacancies.city_ids || excluded.city_ids) as e
          ),
          -- MULTI-REGION additive enrichment (twin of city_ids): UNION the region sets; never shrink.
          region_slugs = (
            select coalesce(array_agg(distinct e), '{}'::text[])
            from unnest(vacancies.region_slugs || excluded.region_slugs) as e
          ),
          -- Owner rule 2026-07-19: lift posted_at to this fresh sighting (the feed sorts posted_at
          -- desc) past the same cooldown. No is_active here: this partial index only matches a live
          -- canonical (where is_active), so a conflict is never with a dark card.
          posted_at = case
            when excluded.posted_at > vacancies.posted_at + make_interval(hours => ${bumpMinHours})
              then excluded.posted_at else vacancies.posted_at end,
          -- Enrich the canonical on repost: fill attributes the first sighting missed,
          -- keep an already-known value (on-conflict-do-update, additive).
          visa_types    = case when cardinality(vacancies.visa_types) = 0 then excluded.visa_types else vacancies.visa_types end,
          placement_fee = case when vacancies.placement_fee = 'unknown' then excluded.placement_fee else vacancies.placement_fee end,
          has_housing   = coalesce(vacancies.has_housing, excluded.has_housing),
          has_meals     = coalesce(vacancies.has_meals, excluded.has_meals),
          -- Keep the link the canonical already has; only FILL it when it was NULL (a later repost from
          -- a channel WITH a username can recover a link the first sighting lacked). Never overwrite a
          -- stored link with NULL — coalesce(old, new), owner rule 2026-07-22.
          source_post_url = coalesce(vacancies.source_post_url, excluded.source_post_url)
        returning id, (xmax = 0) as inserted`;
    } catch {
      // Bad row (e.g. invalid enum from the model) — don't loop on it.
      // eslint-disable-next-line no-console
      console.error('[parser] vacancy insert failed');
      await sql`update raw_messages set status='error', processed_at=now(), error='vacancy_insert_failed', text_hash=${hash} where id=${rawId}::uuid`;
      continue;
    }

    const vacancyId = upserted[0]?.id as string | undefined;
    const isNew = upserted[0]?.inserted === true;
    if (isNew) vacancies += 1;

    await sql`update raw_messages set status='parsed', processed_at=now(), vacancy_id=${vacancyId ?? null}::uuid, text_hash=${hash} where id=${rawId}::uuid`;

    // CONDITIONAL AI-GEO learning (Part B): log any unresolved model city/region name + every decoded
    // slang pair to geo_suggestions for owner /stats. Best-effort — never blocks or fails the parse.
    await recordGeoSuggestions(sql, suggestions);
  }

  return { processed: pending.length + preAiSkipped, vacancies };
}
