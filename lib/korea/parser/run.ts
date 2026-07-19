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
import { getConfigNumber, getConfigString } from '../config.js';
import { textHash } from './texthash.js';
import { extractJson } from './extract-json.js';
import { looksLikeSpam } from './spamfilter.js';
import {
  buildSystemPrompt,
  VISA_TYPES,
  PLACEMENT_FEES,
  type CityRef,
  type ParsedVacancy,
  type VisaType,
  type PlacementFee,
} from './prompt.js';

const VISA_TYPE_SET = new Set<string>(VISA_TYPES);
const PLACEMENT_FEE_SET = new Set<string>(PLACEMENT_FEES);

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

// Cheap, high-precision spam pre-filter — obvious non-jobs (crypto exchange, money-mule,
// leaflet gigs, emoji carpets) are the bulk of the raw stream. Rules + thresholds live in
// parser/spamfilter.ts (extracted so they are unit-testable); rows that match are marked
// reject_reason='spam_prefilter' so the pattern set stays tunable from data.

// Choose the in-batch canonical among byte-identical reposts: the EARLIEST posting wins (a
// missing posted_at sorts LAST so a row with a real timestamp is preferred), id breaks ties so
// the choice is deterministic. Neon returns timestamptz as Date|string; normalize to epoch ms.
function postedMs(r: Record<string, unknown>): number {
  const p = r.posted_at;
  if (p == null) return Number.POSITIVE_INFINITY;
  const t = new Date(p as string | Date).getTime();
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}
function cmpEarliest(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const pa = postedMs(a);
  const pb = postedMs(b);
  if (pa !== pb) return pa < pb ? -1 : 1;
  const ia = a.id as string;
  const ib = b.id as string;
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}
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
    select r.id, r.text, r.source_id, r.posted_at,
           s.title as source_title, s.notes as source_notes
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

  const crossSkips: { rawId: string; hash: string; vacancyId: string; postedMs: number | null }[] = [];
  pending = pending.filter((r) => {
    const h = textHashById.get(r.id as string);
    if (h != null && priorVacancyByHash.has(h)) {
      crossSkips.push({
        rawId: r.id as string,
        hash: h,
        vacancyId: priorVacancyByHash.get(h) as string,
        postedMs: postedMsFinite(r),
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
    const bump = new Map<string, { n: number; freshestMs: number | null }>();
    for (const s of crossSkips) {
      const cur = bump.get(s.vacancyId) ?? { n: 0, freshestMs: null };
      cur.n += 1;
      if (s.postedMs != null && (cur.freshestMs == null || s.postedMs > cur.freshestMs)) {
        cur.freshestMs = s.postedMs;
      }
      bump.set(s.vacancyId, cur);
    }
    for (const [vacancyId, { n, freshestMs }] of bump) {
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
    const sorted = [...group].sort(cmpEarliest);
    for (let i = 1; i < sorted.length; i++) {
      const dupId = sorted[i]!.id as string;
      dropInBatch.set(dupId, textHashById.get(dupId) as string);
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

  // Total skipped before the model = spam + cross-time dups + in-batch dups. Only UNIQUE
  // (or too-short) messages reach the AI below.
  const preAiSkipped = spamIds.length + crossSkips.length + dropInBatch.size;
  if (pending.length === 0) return { processed: preAiSkipped, vacancies: 0 };

  // 2) Active cities → closed enum + prompt context; slug→id + slug→city map.
  const cityRows = await sql`
    select id, slug, name, region_slug from cities where is_active = true order by sort_order, slug`;
  const cities: CityRef[] = cityRows.map((r) => ({
    slug: r.slug as string,
    name: r.name as { ru: string; ko: string; en: string },
    region_slug: (r.region_slug as string | null) ?? null,
  }));
  const regionSlugs = [...new Set(cityRows.map((r) => r.region_slug).filter(Boolean))] as string[];
  const cityIdBySlug = new Map<string, string>(cityRows.map((r) => [r.slug as string, r.id as string]));
  // city/region are guided by the prompt (not a schema enum), so re-close the set on the
  // server: unknown city slug -> null (cityIdBySlug.get below), unknown region -> null here.
  const regionSlugSet = new Set<string>(regionSlugs);

  // 3) Prompt + input. strict structured outputs can't compile our schema, so the required
  // JSON shape + enums live in the system prompt; every field is re-validated server-side.
  const system = buildSystemPrompt(cities, regionSlugs);
  const inputItems = pending.map((r) => {
    const title = ((r.source_title as string | null) ?? '').trim();
    const notes = ((r.source_notes as string | null) ?? '').trim();
    const sourceHint = [title, notes].filter(Boolean).join(' — ');
    const item: { id: string; text: string; source_hint?: string } = {
      id: r.id as string,
      text: (r.text as string | null) ?? '',
    };
    if (sourceHint) item.source_hint = sourceHint;
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
      // The system block is the STABLE cacheable prefix (city list + extraction contract,
      // now ≥4096 tokens so haiku actually caches it — under the min the breakpoint is a
      // silent no-op). ttl:'1h' keeps the prefix warm across a whole cron sweep instead of
      // the default 5m. cache_control stays on the system block ONLY; the per-batch messages
      // below are volatile and MUST come after it so they never enter the cached prefix.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [{ role: 'user', content: JSON.stringify({ messages: inputItems }) }],
    } as Anthropic.MessageCreateParamsNonStreaming);

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

  const byId = new Map<string, ParsedVacancy>(items.map((it) => [it.id, it]));
  let vacancies = 0;

  // 5) Apply each result; move every raw row out of 'pending'.
  for (const row of pending) {
    const rawId = row.id as string;
    const it = byId.get(rawId);
    // Persist the text hash on every row we touch so future ticks can dedup against it
    // (esp. the 'parsed' canonical); null for short texts is a harmless no-op write.
    const hash = textHashById.get(rawId) ?? null;

    if (!it) {
      await sql`update raw_messages set status='error', processed_at=now(), error='no_parser_output', text_hash=${hash} where id=${rawId}::uuid`;
      continue;
    }

    if (!it.is_vacancy || (it.confidence ?? 0) < minConfidence) {
      // Persist WHY + confidence so the corpus is tunable (which reasons over/under-fire).
      await sql`
        update raw_messages
        set status='skipped', processed_at=now(),
            reject_reason=${it.reject_reason ?? (it.is_vacancy ? 'low_confidence' : 'not_vacancy')},
            confidence=${it.confidence ?? null}, text_hash=${hash}
        where id=${rawId}::uuid`;
      continue;
    }

    const cityId = it.city_slug ? cityIdBySlug.get(it.city_slug) ?? null : null;
    const regionSlug = it.region_slug && regionSlugSet.has(it.region_slug) ? it.region_slug : null;
    const visaTypes = cleanVisaTypes(it.visa_types);
    const placementFee = cleanPlacementFee(it.placement_fee);
    const hasHousing = cleanTriState(it.has_housing);
    const hasMeals = cleanTriState(it.has_meals);
    const title = it.title ? it.title.slice(0, 120) : null; // schema no longer caps length
    // Owner rule (2026-07-15): description = the FULL original message text minus contacts
    // (the AI no longer summarizes it, and no longer interprets salary — salary now lives
    // inside this text). scrubContacts strips phones/@handles/t.me·wa.me·kakao links.
    const description = scrubContacts((row.text as string | null) ?? null);

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
          ${it.contact_raw ?? null}, ${cityId}::uuid, ${it.work_type}::work_type,
          ${it.gender}::gender, ${it.dedup_extra ?? null}) as content_hash)
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
      upserted = await sql`
        insert into vacancies (
          city_id, region_slug, work_type, gender, lang,
          title, description, employer,
          contact_raw, contact_kind,
          visa_types, placement_fee, has_housing, has_meals,
          source_id, raw_message_id, posted_at, dedup_extra
        ) values (
          ${cityId}::uuid, ${regionSlug}, ${it.work_type}::work_type, ${it.gender}::gender, ${it.lang ?? null},
          ${title}, ${description}, ${it.employer ?? null},
          ${it.contact_raw ?? null}, ${it.contact_kind ?? null}::contact_kind,
          ${visaTypes}::visa_type[], ${placementFee}::placement_fee, ${hasHousing}, ${hasMeals},
          ${row.source_id}::uuid, ${rawId}::uuid, ${row.posted_at ?? null}, ${it.dedup_extra ?? null}
        )
        on conflict (content_hash) where is_active and duplicate_of is null
        do update set
          repost_count = vacancies.repost_count + 1,
          last_seen_at = now(),
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
          has_meals     = coalesce(vacancies.has_meals, excluded.has_meals)
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
  }

  return { processed: pending.length + preAiSkipped, vacancies };
}
