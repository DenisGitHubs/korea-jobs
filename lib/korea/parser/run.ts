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
import { getConfigNumber, getConfigString } from '../config.js';
import { buildSystemPrompt, buildBatchSchema, type CityRef, type ParsedVacancy } from './prompt.js';

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

  // 1) Oldest pending raw messages.
  const pending = await sql`
    select id, text, source_id, posted_at
    from raw_messages
    where status = 'pending'
    order by fetched_at asc
    limit ${batchSize}`;
  if (pending.length === 0) return { processed: 0, vacancies: 0 };

  // 2) Active cities → closed enum + prompt context; slug→id + slug→city map.
  const cityRows = await sql`
    select id, slug, name, region_slug from cities where is_active = true order by sort_order`;
  const cities: CityRef[] = cityRows.map((r) => ({
    slug: r.slug as string,
    name: r.name as { ru: string; ko: string; en: string },
    region_slug: (r.region_slug as string | null) ?? null,
  }));
  const citySlugs = cities.map((c) => c.slug);
  const regionSlugs = [...new Set(cityRows.map((r) => r.region_slug).filter(Boolean))] as string[];
  const cityIdBySlug = new Map<string, string>(cityRows.map((r) => [r.slug as string, r.id as string]));

  // 3) Prompt + schema. City slug is a closed enum the model cannot step outside.
  const system = buildSystemPrompt(cities, regionSlugs);
  const schema = buildBatchSchema(citySlugs, regionSlugs);
  const inputItems = pending.map((r) => ({ id: r.id as string, text: (r.text as string | null) ?? '' }));

  // 4) One structured call for the whole batch.
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  let items: ParsedVacancy[] = [];
  try {
    const resp = await client.messages.create({
      model,
      max_tokens: 16000,
      // Stable city list first → cacheable prefix (harmless if under the min).
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      // Force the exact output shape; the first text block is valid JSON.
      output_config: { format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: JSON.stringify({ messages: inputItems }) }],
    } as Anthropic.MessageCreateParamsNonStreaming);

    const textBlock = resp.content.find((b) => b.type === 'text');
    if (textBlock && 'text' in textBlock) {
      const parsed = JSON.parse(textBlock.text) as { items?: ParsedVacancy[] };
      items = Array.isArray(parsed.items) ? parsed.items : [];
    }
  } catch {
    // Model/transport fault: leave the batch 'pending' for the next tick. No payload logged.
    // eslint-disable-next-line no-console
    console.error('[parser] extraction call failed');
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
      await sql`update raw_messages set status='skipped', processed_at=now() where id=${rawId}::uuid`;
      continue;
    }

    const cityId = it.city_slug ? cityIdBySlug.get(it.city_slug) ?? null : null;

    // Insert; on dedup conflict bump the canonical instead. (xmax = 0) marks a fresh insert.
    let upserted: Record<string, unknown>[];
    try {
      upserted = await sql`
        insert into vacancies (
          city_id, region_slug, work_type, gender, lang,
          title, description, employer,
          salary_text, salary_min, salary_max, salary_period, salary_currency,
          contact_raw, contact_kind,
          source_id, raw_message_id, posted_at, dedup_extra
        ) values (
          ${cityId}::uuid, ${it.region_slug ?? null}, ${it.work_type}::work_type, ${it.gender}::gender, ${it.lang ?? null},
          ${it.title ?? null}, ${it.description ?? null}, ${it.employer ?? null},
          ${it.salary_text ?? null}, ${it.salary_min ?? null}, ${it.salary_max ?? null},
          ${it.salary_period ?? null}::salary_period, ${it.salary_currency ?? 'KRW'},
          ${it.contact_raw ?? null}, ${it.contact_kind ?? null}::contact_kind,
          ${row.source_id}::uuid, ${rawId}::uuid, ${row.posted_at ?? null}, ${it.dedup_extra ?? null}
        )
        on conflict (content_hash) where is_active and duplicate_of is null
        do update set repost_count = vacancies.repost_count + 1, last_seen_at = now()
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

  return { processed: pending.length, vacancies };
}
