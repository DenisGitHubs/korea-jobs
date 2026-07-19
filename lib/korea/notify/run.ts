// lib/korea/notify/run.ts
//
// Push new matching vacancies AND approved user ads to subscribers' DMs. Decoupled from the
// parser (Sanya §4): separate cron, idempotent + resumable. Each (user, vacancy) and (user, ad)
// push is recorded in notifications_sent (UNIQUE per target) so a re-run never double-notifies.
//
// Retry semantics (Цензор): only 'sent'/'skipped(403)' are recorded — a transient send error is
// NOT recorded and defers the item (notify_pending stays true) so the next tick retries just the
// un-notified subscribers. Only city-scoped items are pushed; city-less ones have their pending
// flag cleared up front so they don't get rescanned forever. Vacancies are swept first, then ads;
// both share one per-run send cap and the same permissive subscription-match logic.

import { getSql } from '../core/db.js';
import { getConfigBool, getConfigNumber } from '../config.js';
import { sendMessage, isUserUnavailable, retryAfterSeconds } from '../bot/telegram.js';
import { workTypeLabelRu } from '../core/labels.js';
import { scrubContacts } from '../core/scrub.js';

export interface NotifyResult {
  vacancies: number;
  ads: number;
  sent: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Deep link that opens the mini app directly on this item's card (SPA rewrite serves index.html). */
function feedUrl(appUrl: string, id: string): string {
  return `${appUrl.replace(/\/+$/, '')}/feed/${id}`;
}

/** The single "Открыть" inline button that deep-links to the item, or {} when APP_URL is unset. */
function openButton(appUrl: string | undefined, id: string): Record<string, unknown> {
  return appUrl
    ? { reply_markup: { inline_keyboard: [[{ text: 'Открыть', web_app: { url: feedUrl(appUrl, id) } }]] } }
    : {};
}

/** Classification of one Bot API send, so both loops share identical retry/skip/rate-limit rules. */
type SendClass =
  | { kind: 'sent'; messageId: number | null }
  | { kind: 'unavailable' } // 403: blocked / never started → skip, no retry
  | { kind: 'ratelimited'; retryAfter: number } // 429: wait and resume next tick
  | { kind: 'transient' }; // unknown/transport: do not record, defer the item

async function classifySend(
  telegramId: string,
  text: string,
  extra: Record<string, unknown>,
): Promise<SendClass> {
  const resp = await sendMessage(telegramId, text, extra);
  if (resp.ok) return { kind: 'sent', messageId: resp.result?.message_id ?? null };
  if (isUserUnavailable(resp)) return { kind: 'unavailable' };
  const ra = retryAfterSeconds(resp);
  if (ra !== null) return { kind: 'ratelimited', retryAfter: ra };
  return { kind: 'transient' };
}

interface VacRow {
  id: string;
  work_type: string;
  city_id: string;
  city_name: { ru: string; ko: string; en: string };
  salary_text: string | null;
  visa_types: string[];
  placement_fee: string;
  has_housing: boolean | null;
  has_meals: boolean | null;
}

interface AdRow {
  id: string;
  work_type: string;
  city_id: string;
  city_name: { ru: string; ko: string; en: string };
  salary_text: string | null;
  visa_types: string[];
  placement_fee: string;
  has_housing: boolean | null;
  has_meals: boolean | null;
  author_user_id: string | null;
}

// salary_text goes through scrubContacts (007): on user ads the author controls the field and
// could smuggle a phone/@handle into subscribers' DMs, bypassing the paid contact-reveal gate.
// Scrubbing the scraped-vacancy path too keeps the two texts symmetric (defense in depth).
function buildVacText(v: VacRow): string {
  const city = v.city_name?.ru ?? '';
  const clean = scrubContacts(v.salary_text);
  const salary = clean ? ` · ${clean}` : '';
  return `Новая вакансия: ${city} · ${workTypeLabelRu(v.work_type)}${salary}`; // plain text — no parse_mode
}

function buildAdText(a: AdRow): string {
  const city = a.city_name?.ru ?? '';
  const clean = scrubContacts(a.salary_text);
  const salary = clean ? ` · ${clean}` : '';
  return `Новое объявление: ${city} · ${workTypeLabelRu(a.work_type)}${salary}`; // plain text — no parse_mode
}

export async function runNotify(): Promise<NotifyResult> {
  if (!(await getConfigBool('notify_enabled', true))) return { vacancies: 0, ads: 0, sent: 0 };

  const sql = getSql();

  // City-less items are never pushed (subscriptions are city-scoped) — clear their pending flag
  // so they aren't rescanned every tick. Same rule for vacancies and approved ads.
  await sql`update vacancies set notify_pending = false where notify_pending and city_id is null`;
  await sql`update user_ads set notify_pending = false where notify_pending and city_id is null`;

  const batch = await getConfigNumber('notify_vacancy_batch', 10);
  const sendCap = await getConfigNumber('notify_send_cap', 200);
  const appUrl = process.env.APP_URL;

  let sent = 0;

  // ── Vacancies ──────────────────────────────────────────────────────────────────────────────
  const vacs = (await sql`
    select v.id, v.work_type, v.city_id, c.name as city_name, v.salary_text,
           v.visa_types, v.placement_fee, v.has_housing, v.has_meals
    from vacancies v join cities c on c.id = v.city_id
    where v.notify_pending and v.is_active and v.duplicate_of is null
    order by v.first_seen_at asc
    limit ${batch}`) as unknown as VacRow[];

  for (const v of vacs) {
    let deferred = false;

    // Persistent filter match is PERMISSIVE (Sanya/Roma K2): a filter excludes only a row that
    // EXPLICITLY contradicts it; "not stated" / empty always passes, so a rare attribute never
    // empties the push.
    const subs = (await sql`
      select u.id as user_id, u.telegram_id
      from subscriptions s join users u on u.id = s.user_id
      where s.notify and u.allows_write_to_pm and not u.is_blocked
        and (cardinality(s.city_ids) = 0 or s.city_ids @> array[${v.city_id}::uuid])
        and (s.work_types is null or cardinality(s.work_types) = 0 or ${v.work_type}::work_type = any(s.work_types))
        and (
          cardinality(s.visa_types) = 0
          or cardinality(${v.visa_types}::visa_type[]) = 0
          or 'any' = any(${v.visa_types}::visa_type[])
          or s.visa_types && ${v.visa_types}::visa_type[]
        )
        and (
          s.placement_fee is null
          or ${v.placement_fee}::placement_fee = s.placement_fee
          or ${v.placement_fee}::placement_fee = 'unknown'
        )
        and (s.require_housing is not true or ${v.has_housing}::boolean is true or ${v.has_housing}::boolean is null)
        and (s.require_meals   is not true or ${v.has_meals}::boolean   is true or ${v.has_meals}::boolean   is null)
        and not exists (
          select 1 from notifications_sent n where n.user_id = u.id and n.vacancy_id = ${v.id}::uuid
        )`) as unknown as { user_id: string; telegram_id: string }[];

    const text = buildVacText(v);
    const extra = openButton(appUrl, v.id);

    for (const s of subs) {
      if (sent >= sendCap) return { vacancies: vacs.length, ads: 0, sent }; // hard cap this run

      const r = await classifySend(String(s.telegram_id), text, extra);
      if (r.kind === 'sent') {
        sent += 1;
        await sql`
          insert into notifications_sent (user_id, vacancy_id, status, tg_message_id)
          values (${s.user_id}::uuid, ${v.id}::uuid, 'sent', ${r.messageId})
          on conflict (user_id, vacancy_id) do nothing`;
      } else if (r.kind === 'unavailable') {
        await sql`update users set is_blocked = true where id = ${s.user_id}::uuid`;
        await sql`
          insert into notifications_sent (user_id, vacancy_id, status)
          values (${s.user_id}::uuid, ${v.id}::uuid, 'skipped')
          on conflict (user_id, vacancy_id) do nothing`;
      } else if (r.kind === 'ratelimited') {
        await sleep((r.retryAfter + 1) * 1000); // vacancy stays notify_pending; next tick resumes
        return { vacancies: vacs.length, ads: 0, sent };
      } else {
        deferred = true; // transient: do NOT record — defer this vacancy for a retry
        // eslint-disable-next-line no-console
        console.error('[notify] send failed (deferred)');
      }

      await sleep(40); // ~25/s, under the global 30/s Bot API ceiling
    }

    // Mark done only if every subscriber was resolved (sent or permanently skipped).
    if (!deferred) {
      await sql`update vacancies set notify_pending = false where id = ${v.id}::uuid`;
    }
  }

  // ── Approved user ads ──────────────────────────────────────────────────────────────────────
  // Same batch size + same permissive subscription match as vacancies, PLUS: exclude the author,
  // and dedup on notifications_sent.ad_id. A city-less ad is already cleared above (never pushed).
  const ads = (await sql`
    select a.id, a.work_type, a.city_id, c.name as city_name, a.salary_text,
           a.visa_types, a.placement_fee, a.has_housing, a.has_meals, a.author_user_id
    from user_ads a join cities c on c.id = a.city_id
    where a.notify_pending and a.status = 'approved'
    order by a.created_at asc
    limit ${batch}`) as unknown as AdRow[];

  for (const a of ads) {
    let deferred = false;

    const subs = (await sql`
      select u.id as user_id, u.telegram_id
      from subscriptions s join users u on u.id = s.user_id
      where s.notify and u.allows_write_to_pm and not u.is_blocked
        and u.id is distinct from ${a.author_user_id}::uuid
        and (cardinality(s.city_ids) = 0 or s.city_ids @> array[${a.city_id}::uuid])
        and (s.work_types is null or cardinality(s.work_types) = 0 or ${a.work_type}::work_type = any(s.work_types))
        and (
          cardinality(s.visa_types) = 0
          or cardinality(${a.visa_types}::visa_type[]) = 0
          or 'any' = any(${a.visa_types}::visa_type[])
          or s.visa_types && ${a.visa_types}::visa_type[]
        )
        and (
          s.placement_fee is null
          or ${a.placement_fee}::placement_fee = s.placement_fee
          or ${a.placement_fee}::placement_fee = 'unknown'
        )
        and (s.require_housing is not true or ${a.has_housing}::boolean is true or ${a.has_housing}::boolean is null)
        and (s.require_meals   is not true or ${a.has_meals}::boolean   is true or ${a.has_meals}::boolean   is null)
        and not exists (
          select 1 from notifications_sent n where n.user_id = u.id and n.ad_id = ${a.id}::uuid
        )`) as unknown as { user_id: string; telegram_id: string }[];

    const text = buildAdText(a);
    const extra = openButton(appUrl, a.id);

    for (const s of subs) {
      if (sent >= sendCap) return { vacancies: vacs.length, ads: ads.length, sent }; // hard cap this run

      const r = await classifySend(String(s.telegram_id), text, extra);
      if (r.kind === 'sent') {
        sent += 1;
        await sql`
          insert into notifications_sent (user_id, ad_id, status, tg_message_id)
          values (${s.user_id}::uuid, ${a.id}::uuid, 'sent', ${r.messageId})
          on conflict (user_id, ad_id) where ad_id is not null do nothing`;
      } else if (r.kind === 'unavailable') {
        await sql`update users set is_blocked = true where id = ${s.user_id}::uuid`;
        await sql`
          insert into notifications_sent (user_id, ad_id, status)
          values (${s.user_id}::uuid, ${a.id}::uuid, 'skipped')
          on conflict (user_id, ad_id) where ad_id is not null do nothing`;
      } else if (r.kind === 'ratelimited') {
        await sleep((r.retryAfter + 1) * 1000); // ad stays notify_pending; next tick resumes
        return { vacancies: vacs.length, ads: ads.length, sent };
      } else {
        deferred = true; // transient: do NOT record — defer this ad for a retry
        // eslint-disable-next-line no-console
        console.error('[notify] ad send failed (deferred)');
      }

      await sleep(40);
    }

    if (!deferred) {
      await sql`update user_ads set notify_pending = false where id = ${a.id}::uuid`;
    }
  }

  return { vacancies: vacs.length, ads: ads.length, sent };
}
