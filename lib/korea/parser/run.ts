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

/**
 * Extract the JSON object from a model reply. strict structured outputs cannot compile
 * our schema (big object × batch array — rejected as "too complex"/grammar timeout), so
 * we ask for JSON in the prompt and parse defensively: drop any ```json fences and any
 * prose around the object by slicing from the first '{' to the last '}'. Throws on bad
 * JSON — the caller's try/catch then leaves the batch 'pending' for a retry.
 */
function extractJson(text: string): unknown {
  let s = text.trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const inner = fenced?.[1];
  if (inner) s = inner.trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last > first) s = s.slice(first, last + 1);
  return JSON.parse(s);
}

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
// leaflet gigs) are the bulk of the raw stream. CONSERVATIVE by design (precision >>
// recall): only near-certain spam matches; anything borderline still goes to the model.
// Rows are marked reject_reason='spam_prefilter' so the pattern set is tunable from data.
const SPAM_PATTERNS: RegExp[] = [
  /\busdt\b|\busdc\b|bitcoin|биткоин/i,
  /крипт[оаыу]?\b|криптовалют|криптоактив|криптообмен/i,
  /обмен\s+(валют|usdt|usd|крипт|наличк|денег)/i,
  /перестановк\w*\s+средств/i,
  /inside\s*exchange|exchange\s*express|otc[- ]?сервис/i,
  /доплат\w*\s+за\s+(usdt|крипт)/i,
  /вон[ыа]?\s*(на|→|->)\s*рубл|рубл\w*\s*(на|→|->)\s*вон/i,
  /обнал\w+|\bдроп(ы|ов|ами)?\b|аренд\w*\s+карт/i,
  /листовк/i,
  /\bbybit\b|трейдинг/i,
];
function looksLikeSpam(text: string): boolean {
  const t = text.toLowerCase();
  return SPAM_PATTERNS.some((re) => re.test(t));
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
  const pending = pendingAll.filter((r) => {
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

  // 2) Active cities → closed enum + prompt context; slug→id + slug→city map.
  const cityRows = await sql`
    select id, slug, name, region_slug from cities where is_active = true order by sort_order`;
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
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  let items: ParsedVacancy[] = [];
  try {
    const resp = await client.messages.create({
      model,
      max_tokens: 16000,
      // Stable city list first → cacheable prefix (harmless if under the min).
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
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

    if (!it) {
      await sql`update raw_messages set status='error', processed_at=now(), error='no_parser_output' where id=${rawId}::uuid`;
      continue;
    }

    if (!it.is_vacancy || (it.confidence ?? 0) < minConfidence) {
      // Persist WHY + confidence so the corpus is tunable (which reasons over/under-fire).
      await sql`
        update raw_messages
        set status='skipped', processed_at=now(),
            reject_reason=${it.reject_reason ?? (it.is_vacancy ? 'low_confidence' : 'not_vacancy')},
            confidence=${it.confidence ?? null}
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

    // Takedown gate (007 CRIT): never resurrect content taken down for a ToS 5.2(i)
    // contact violation. The prospective content_hash is computed via kj_content_hash
    // (an exact mirror of the generated column) since the real hash only exists after
    // insert. If the hash is on the takedown list, skip without inserting.
    const blocked = await sql`
      select 1 from takedowns
      where content_hash = kj_content_hash(
        ${it.contact_raw ?? null}, ${cityId}::uuid, ${it.work_type}::work_type,
        ${it.gender}::gender, ${it.dedup_extra ?? null})
      limit 1`;
    if (blocked.length > 0) {
      await sql`
        update raw_messages set status='skipped', processed_at=now(), reject_reason='takedown'
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
      await sql`update raw_messages set status='error', processed_at=now(), error='vacancy_insert_failed' where id=${rawId}::uuid`;
      continue;
    }

    const vacancyId = upserted[0]?.id as string | undefined;
    const isNew = upserted[0]?.inserted === true;
    if (isNew) vacancies += 1;

    await sql`update raw_messages set status='parsed', processed_at=now(), vacancy_id=${vacancyId ?? null}::uuid where id=${rawId}::uuid`;
  }

  return { processed: pending.length + spamIds.length, vacancies };
}
