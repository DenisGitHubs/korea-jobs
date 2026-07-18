// lib/korea/notify/run.ts
//
// Push new matching vacancies to subscribers' DMs. Decoupled from the parser
// (Sanya §4): separate cron, idempotent + resumable. Each (user, vacancy) push is
// recorded in notifications_sent (UNIQUE) so a re-run never double-notifies.
//
// Retry semantics (Цензор): only 'sent'/'skipped(403)' are recorded — a transient
// send error is NOT recorded and defers the vacancy (notify_pending stays true) so
// the next tick retries just the un-notified subscribers. Only city-scoped vacancies
// are pushed; city-less ones have their pending flag cleared up front so they don't
// get rescanned forever.

import { getSql } from '../core/db.js';
import { getConfigBool, getConfigNumber } from '../config.js';
import { sendMessage, isUserUnavailable, retryAfterSeconds } from '../bot/telegram.js';

const WORK_TYPE_LABEL_RU: Record<string, string> = {
  factory: 'Завод',
  construction: 'Стройка',
  agriculture: 'Поле, ферма',
  fishery: 'Рыбзавод',
  food: 'Пищёвка',
  logistics: 'Склад',
  restaurant: 'Общепит',
  cleaning: 'Уборка',
  caregiving: 'Уход',
  hotel: 'Отель',
  services: 'Услуги',
  other: 'Другое',
};

export interface NotifyResult {
  vacancies: number;
  sent: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

function buildText(v: VacRow): string {
  const city = v.city_name?.ru ?? '';
  const wt = WORK_TYPE_LABEL_RU[v.work_type] ?? v.work_type;
  const salary = v.salary_text ? ` · ${v.salary_text}` : '';
  return `Новая вакансия: ${city} · ${wt}${salary}`; // plain text — no parse_mode (untrusted fields)
}

export async function runNotify(): Promise<NotifyResult> {
  if (!(await getConfigBool('notify_enabled', true))) return { vacancies: 0, sent: 0 };

  const sql = getSql();

  // City-less vacancies are never pushed (subscriptions are city-scoped) — clear their
  // pending flag so they aren't rescanned every tick.
  await sql`update vacancies set notify_pending = false where notify_pending and city_id is null`;

  const vacBatch = await getConfigNumber('notify_vacancy_batch', 10);
  const sendCap = await getConfigNumber('notify_send_cap', 200);
  const appUrl = process.env.APP_URL;

  const vacs = (await sql`
    select v.id, v.work_type, v.city_id, c.name as city_name, v.salary_text,
           v.visa_types, v.placement_fee, v.has_housing, v.has_meals
    from vacancies v join cities c on c.id = v.city_id
    where v.notify_pending and v.is_active and v.duplicate_of is null
    order by v.first_seen_at asc
    limit ${vacBatch}`) as unknown as VacRow[];

  let sent = 0;

  for (const v of vacs) {
    let deferred = false;

    // Persistent filter match is PERMISSIVE (Sanya/Roma K2): a filter excludes only a
    // row that EXPLICITLY contradicts it; "not stated" / empty always passes, so a rare
    // attribute never empties the push.
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

    const text = buildText(v);
    const extra = appUrl
      ? { reply_markup: { inline_keyboard: [[{ text: 'Открыть', web_app: { url: appUrl } }]] } }
      : {};

    for (const s of subs) {
      if (sent >= sendCap) return { vacancies: vacs.length, sent }; // hard cap this run

      const resp = await sendMessage(String(s.telegram_id), text, extra);

      if (resp.ok) {
        sent += 1;
        await sql`
          insert into notifications_sent (user_id, vacancy_id, status, tg_message_id)
          values (${s.user_id}::uuid, ${v.id}::uuid, 'sent', ${resp.result?.message_id ?? null})
          on conflict (user_id, vacancy_id) do nothing`;
      } else if (isUserUnavailable(resp)) {
        await sql`update users set is_blocked = true where id = ${s.user_id}::uuid`;
        await sql`
          insert into notifications_sent (user_id, vacancy_id, status)
          values (${s.user_id}::uuid, ${v.id}::uuid, 'skipped')
          on conflict (user_id, vacancy_id) do nothing`;
      } else {
        const ra = retryAfterSeconds(resp);
        if (ra !== null) {
          // Rate limited: wait and stop. Vacancy stays notify_pending; next tick resumes.
          await sleep((ra + 1) * 1000);
          return { vacancies: vacs.length, sent };
        }
        // Transient/unknown error: DO NOT record — defer this vacancy for a retry.
        deferred = true;
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

  return { vacancies: vacs.length, sent };
}
