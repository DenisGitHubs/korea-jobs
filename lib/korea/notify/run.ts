// lib/korea/notify/run.ts
//
// Push new matching vacancies AND approved user ads to subscribers' DMs. Decoupled from the
// parser (Sanya §4): separate cron, idempotent + resumable. Each (user, vacancy) and (user, ad)
// push is recorded in notifications_sent (UNIQUE per target) so a re-run never double-notifies.
//
// GROUPED DELIVERY (owner, 2026-07-19): instead of one DM per (user × item), a run sends ONE DM
// per user covering every item matched this tick. A user with a single match still gets the old
// one-line format + "Открыть" button; several matches collapse into a header ("Новые вакансии: N")
// plus one inline web_app button per item — label "Город · Тип (· зарплата)", each deep-linking to
// its own /feed/<id> card. At most notify_group_cap buttons per DM; any overflow for that user
// stays notify_pending and is delivered on a later tick.
//
// Retry semantics (Цензор), preserved per included item: a 'sent'/'skipped(403)' is recorded — a
// transient send error records NOTHING and defers every item in that DM (their notify_pending stays
// true) so the next tick retries just the un-notified subscribers. A 429 sleeps and stops the run
// with the current DM unrecorded, so all its items resend next tick. A notify_pending flag is
// cleared only once a post-run re-check finds no un-notified matching subscriber left for that item.
// Only city-scoped items are pushed; city-less ones have their pending flag cleared up front. The
// per-run cap counts MESSAGES (the Bot API ceiling is per message); a 40ms gap paces the sends.

import { getSql } from '../core/db.js';
import { getConfigBool, getConfigNumber } from '../config.js';
import { sendMessage, isUserUnavailable, retryAfterSeconds } from '../bot/telegram.js';
import { workTypeLabelRu } from '../core/labels.js';
import { scrubContacts } from '../core/scrub.js';

type Sql = ReturnType<typeof getSql>;

export interface NotifyResult {
  vacancies: number;
  ads: number;
  sent: number; // messages sent this run (a grouped DM counts once), not items delivered
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Telegram InlineKeyboardButton.text is 1–64 UTF-16 code units (Susanin brief, Bot API 6.0+).
const BUTTON_TEXT_MAX = 64;

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

/** Fields shared by a vacancy and an ad that the DM text/buttons render. */
interface Displayable {
  work_type: string;
  city_name: { ru: string; ko: string; en: string };
  salary_text: string | null;
}

interface VacRow extends Displayable {
  id: string;
  city_id: string;
  visa_types: string[];
  placement_fee: string;
  has_housing: boolean | null;
  has_meals: boolean | null;
}

interface AdRow extends Displayable {
  id: string;
  city_id: string;
  visa_types: string[];
  placement_fee: string;
  has_housing: boolean | null;
  has_meals: boolean | null;
  author_user_id: string | null;
}

/** One matched item destined for a user's grouped DM. */
type Position =
  | { kind: 'vacancy'; id: string; item: VacRow }
  | { kind: 'ad'; id: string; item: AdRow };

interface Recipient {
  telegramId: string;
  positions: Position[]; // in encounter order: vacancies (oldest first) then ads (oldest first)
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

/** Header line for a grouped DM (>1 item): distinguishes vacancy-only / ad-only / mixed batches. */
function groupHeader(positions: Position[]): string {
  const vac = positions.filter((p) => p.kind === 'vacancy').length;
  const ad = positions.length - vac;
  if (ad === 0) return `Новые вакансии: ${vac}`;
  if (vac === 0) return `Новые объявления: ${ad}`;
  return `Новые вакансии и объявления: ${positions.length}`;
}

/**
 * Button label for one item: "Город · Тип" plus "· зарплата" when it still fits the Bot API 64-char
 * button limit. salary_text is scrubbed exactly like the DM body. Never empty (falls back to "Открыть").
 */
function buttonLabel(item: Displayable): string {
  const parts = [item.city_name?.ru ?? '', workTypeLabelRu(item.work_type)].filter((s) => s.length > 0);
  const base = parts.join(' · ');
  const clean = scrubContacts(item.salary_text);
  const withSalary = clean ? `${base} · ${clean}` : base;
  const label = withSalary.length <= BUTTON_TEXT_MAX ? withSalary : base;
  if (label.length === 0) return 'Открыть';
  return label.length <= BUTTON_TEXT_MAX ? label : label.slice(0, BUTTON_TEXT_MAX);
}

/**
 * Compose one user's DM. A single position keeps the legacy one-line text + "Открыть" button; several
 * collapse into a header + one web_app button per item (each its own keyboard row). With APP_URL unset
 * there is no way to deep-link, so a grouped DM degrades to header-only text (as the single path does).
 */
function buildUserMessage(
  positions: Position[],
  appUrl: string | undefined,
): { text: string; extra: Record<string, unknown> } {
  const [first] = positions;
  if (positions.length === 1 && first) {
    const text = first.kind === 'vacancy' ? buildVacText(first.item) : buildAdText(first.item);
    return { text, extra: openButton(appUrl, first.id) };
  }
  const text = groupHeader(positions);
  if (!appUrl) return { text, extra: {} };
  const inline_keyboard = positions.map((p) => [
    { text: buttonLabel(p.item), web_app: { url: feedUrl(appUrl, p.id) } },
  ]);
  return { text, extra: { reply_markup: { inline_keyboard } } };
}

/**
 * Un-notified subscribers whose PERSISTENT filter matches this vacancy. The match is PERMISSIVE
 * (Sanya/Roma K2): a filter excludes only a row that EXPLICITLY contradicts it; "not stated" / empty
 * always passes, so a rare attribute never empties the push. Re-run after sends, an empty result means
 * the vacancy has reached every eligible subscriber → its notify_pending can be cleared.
 */
function vacSubs(sql: Sql, v: VacRow): Promise<{ user_id: string; telegram_id: string }[]> {
  return sql`
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
      )` as Promise<{ user_id: string; telegram_id: string }[]>;
}

/** Ad twin of vacSubs — same permissive match, PLUS excludes the author, deduped on ad_id. */
function adSubs(sql: Sql, a: AdRow): Promise<{ user_id: string; telegram_id: string }[]> {
  return sql`
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
      )` as Promise<{ user_id: string; telegram_id: string }[]>;
}

/** Record a delivered push for one item (vacancy XOR ad), idempotent on the per-target unique. */
async function recordSent(sql: Sql, userId: string, p: Position, messageId: number | null): Promise<void> {
  if (p.kind === 'vacancy') {
    await sql`
      insert into notifications_sent (user_id, vacancy_id, status, tg_message_id)
      values (${userId}::uuid, ${p.id}::uuid, 'sent', ${messageId})
      on conflict (user_id, vacancy_id) do nothing`;
  } else {
    await sql`
      insert into notifications_sent (user_id, ad_id, status, tg_message_id)
      values (${userId}::uuid, ${p.id}::uuid, 'sent', ${messageId})
      on conflict (user_id, ad_id) where ad_id is not null do nothing`;
  }
}

/** Record a permanently-skipped push (403) for one item, idempotent on the per-target unique. */
async function recordSkipped(sql: Sql, userId: string, p: Position): Promise<void> {
  if (p.kind === 'vacancy') {
    await sql`
      insert into notifications_sent (user_id, vacancy_id, status)
      values (${userId}::uuid, ${p.id}::uuid, 'skipped')
      on conflict (user_id, vacancy_id) do nothing`;
  } else {
    await sql`
      insert into notifications_sent (user_id, ad_id, status)
      values (${userId}::uuid, ${p.id}::uuid, 'skipped')
      on conflict (user_id, ad_id) where ad_id is not null do nothing`;
  }
}

/** Add one matched position to a user's DM bucket, creating the bucket on first sighting. */
function collect(map: Map<string, Recipient>, userId: string, telegramId: string, p: Position): void {
  const cur = map.get(userId);
  if (cur) cur.positions.push(p);
  else map.set(userId, { telegramId, positions: [p] });
}

export async function runNotify(): Promise<NotifyResult> {
  if (!(await getConfigBool('notify_enabled', true))) return { vacancies: 0, ads: 0, sent: 0 };

  const sql = getSql();

  // City-less items are never pushed (subscriptions are city-scoped) — clear their pending flag
  // so they aren't rescanned every tick. Same rule for vacancies and approved ads.
  await sql`update vacancies set notify_pending = false where notify_pending and city_id is null`;
  await sql`update user_ads set notify_pending = false where notify_pending and city_id is null`;

  const batch = await getConfigNumber('notify_vacancy_batch', 10);
  const sendCap = await getConfigNumber('notify_send_cap', 200); // messages per run
  const groupCap = await getConfigNumber('notify_group_cap', 6); // items (buttons) per DM
  const appUrl = process.env.APP_URL;

  // ── 1. Fetch this tick's pending items (same permissive scope, order, and batch as before) ───
  const vacs = (await sql`
    select v.id, v.work_type, v.city_id, c.name as city_name, v.salary_text,
           v.visa_types, v.placement_fee, v.has_housing, v.has_meals
    from vacancies v join cities c on c.id = v.city_id
    where v.notify_pending and v.is_active and v.duplicate_of is null
    order by v.first_seen_at asc
    limit ${batch}`) as unknown as VacRow[];

  const ads = (await sql`
    select a.id, a.work_type, a.city_id, c.name as city_name, a.salary_text,
           a.visa_types, a.placement_fee, a.has_housing, a.has_meals, a.author_user_id
    from user_ads a join cities c on c.id = a.city_id
    where a.notify_pending and a.status = 'approved'
    order by a.created_at asc
    limit ${batch}`) as unknown as AdRow[];

  // ── 2. Invert item→subscribers into user→items (vacancies first, then ads, both oldest first) ─
  const byUser = new Map<string, Recipient>();
  for (const v of vacs) {
    for (const s of await vacSubs(sql, v)) {
      collect(byUser, s.user_id, String(s.telegram_id), { kind: 'vacancy', id: v.id, item: v });
    }
  }
  for (const a of ads) {
    for (const s of await adSubs(sql, a)) {
      collect(byUser, s.user_id, String(s.telegram_id), { kind: 'ad', id: a.id, item: a });
    }
  }

  // ── 3. One DM per user, up to groupCap items; overflow stays pending for a later tick ─────────
  let sent = 0;
  for (const [userId, rcpt] of byUser) {
    if (sent >= sendCap) break; // per-run message cap: untouched users stay pending, resume next tick

    const included = rcpt.positions.slice(0, groupCap);
    const { text, extra } = buildUserMessage(included, appUrl);
    const r = await classifySend(rcpt.telegramId, text, extra);

    if (r.kind === 'sent') {
      sent += 1;
      for (const p of included) await recordSent(sql, userId, p, r.messageId);
    } else if (r.kind === 'unavailable') {
      await sql`update users set is_blocked = true where id = ${userId}::uuid`;
      for (const p of included) await recordSkipped(sql, userId, p);
    } else if (r.kind === 'ratelimited') {
      await sleep((r.retryAfter + 1) * 1000); // DM unrecorded → its items stay pending; stop the run
      break;
    } else {
      // transient: record NOTHING — every item in this DM defers for a retry next tick
      // eslint-disable-next-line no-console
      console.error('[notify] send failed (deferred)');
    }

    await sleep(40); // ~25 msg/s, under the global 30/s Bot API ceiling
  }

  // ── 4. Clear notify_pending for any item that now has no un-notified matching subscriber left ──
  // Re-runs the exact permissive match: an empty result means every eligible subscriber was reached
  // (this run or earlier). Items still awaiting someone — capped overflow, a deferred/rate-limited or
  // never-processed user — keep the flag and are picked up next tick. Robust to mid-run subscription
  // changes, and correct however the send loop ended (cap/break included).
  for (const v of vacs) {
    if ((await vacSubs(sql, v)).length === 0) {
      await sql`update vacancies set notify_pending = false where id = ${v.id}::uuid`;
    }
  }
  for (const a of ads) {
    if ((await adSubs(sql, a)).length === 0) {
      await sql`update user_ads set notify_pending = false where id = ${a.id}::uuid`;
    }
  }

  return { vacancies: vacs.length, ads: ads.length, sent };
}
