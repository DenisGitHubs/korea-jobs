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
//
// MULTI-GEO (regions wave): the app-wide geo rule lives in kj_geo_match (draft_0021) and is used by
// the feed + digest. notify is DELIBERATELY NARROWER and does NOT use the no_city (u) toggle: it
// pushes an offer that has SOME geo (≥1 city OR ≥1 region) and matches a subscriber by ARRAY OVERLAP —
// s.city_ids && offer.city_ids OR s.region_slugs && offer.region_slugs (a subscriber with NO city AND
// NO region, both cardinality 0, still gets everything). An offer with NO geo at all is never pushed
// (its pending flag is cleared up front). The `no_city` toggle governs only the passive feed/digest
// surface, where a user browses city-less offers on purpose; a realtime DM about one would be noise.
//
// PER-USER DAILY CAP (owner, 2026-07-26): subscriptions.notify_daily_cap (draft_0026) is a personal
// ceiling on DMs (LETTERS, not offers) per Asia/Seoul calendar day — NULL means no limit, and NULL
// is what EVERY row holds until its owner picks a number in the settings (the column has no default
// and nobody was backfilled). Before the send loop we run ONE grouped query (never N+1) that
// gives, for every candidate of this run, their cap and how many successful DMs they already got
// since Seoul midnight; a user at or over budget is skipped for the rest of the day. The count is
// over DISTINCT tg_message_id because notifications_sent holds one row PER OFFER while a grouped DM
// covers up to notify_group_cap of them. See "WHAT HAPPENS TO THE OFFERS" on recordSkipped below.


import { getSql } from '../core/db.js';
import { getConfigBool, getConfigNumber } from '../config.js';
import { sendMessage, isUserUnavailable, retryAfterSeconds } from '../bot/telegram.js';
import { workTypeLabelRu } from '../core/labels.js';
import { scrubContacts } from '../core/scrub.js';
import { isOverDailyCap } from './cap.js';

type Sql = ReturnType<typeof getSql>;

export interface NotifyResult {
  vacancies: number;
  ads: number;
  sent: number; // messages sent this run (a grouped DM counts once), not items delivered
  capped: number; // users skipped this run because they had used up their own daily DM budget
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
  city_id: string | null; // PRIMARY city (may be null on a repost-only card); display via coalesce
  city_ids: string[]; // MULTI-CITY: the full city set, matched against subscribers by array overlap
  region_slugs: string[]; // MULTI-REGION: the full region set, matched against subscribers by overlap
  visa_types: string[];
  placement_fee: string;
  has_housing: boolean | null;
  has_meals: boolean | null;
}

interface AdRow extends Displayable {
  id: string;
  city_id: string | null;
  city_ids: string[];
  region_slugs: string[];
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
// MULTI-REGION: a region-only offer (no city) now gets pushed — its city_name is null, so the city
// part is DROPPED gracefully (the user opens the card to see the region) instead of rendering a stray
// "· " separator with an empty location.
function buildVacText(v: VacRow): string {
  const parts = [v.city_name?.ru ?? '', workTypeLabelRu(v.work_type)].filter((s) => s.length > 0);
  const clean = scrubContacts(v.salary_text);
  const salary = clean ? ` · ${clean}` : '';
  return `Новая вакансия: ${parts.join(' · ')}${salary}`; // plain text — no parse_mode
}

function buildAdText(a: AdRow): string {
  const parts = [a.city_name?.ru ?? '', workTypeLabelRu(a.work_type)].filter((s) => s.length > 0);
  const clean = scrubContacts(a.salary_text);
  const salary = clean ? ` · ${clean}` : '';
  return `Новое объявление: ${parts.join(' · ')}${salary}`; // plain text — no parse_mode
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
      and (
        (cardinality(s.city_ids) = 0 and cardinality(s.region_slugs) = 0)
        or s.city_ids && ${v.city_ids}::uuid[]
        or s.region_slugs && ${v.region_slugs}::text[]
      )
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
      and (
        (cardinality(s.city_ids) = 0 and cardinality(s.region_slugs) = 0)
        or s.city_ids && ${a.city_ids}::uuid[]
        or s.region_slugs && ${a.region_slugs}::text[]
      )
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

/**
 * Record a permanently-skipped push for one item, idempotent on the per-target unique.
 * `reason` lands in notifications_sent.error so the two skip causes stay tellable apart:
 *   * null         — 403: the user blocked the bot / never started it;
 *   * 'daily_cap'  — the user's own per-day DM budget was already spent (see below).
 *
 * WHAT HAPPENS TO THE OFFERS WHEN A USER IS OVER THEIR CAP — deliberate, and it matters:
 * the offer is NOT re-queued for that person; it is dropped from THEIR realtime channel for good
 * (they still see it in the feed and in the daily digest, which this cap does not touch).
 * The alternative — leaving the offer notify_pending until the user's day rolls over — deadlocks
 * the whole cron: step 1 always takes the OLDEST pending offers, so items held for one capped
 * subscriber would permanently occupy the batch and every OTHER subscriber would stop receiving
 * anything. Recording the skip keeps the queue draining, matches what the person actually asked
 * for ("no more than N notifications a day" — the surplus is by definition unwanted), and stays
 * auditable: select ... from notifications_sent where error = 'daily_cap'.
 */
async function recordSkipped(sql: Sql, userId: string, p: Position, reason: string | null = null): Promise<void> {
  if (p.kind === 'vacancy') {
    await sql`
      insert into notifications_sent (user_id, vacancy_id, status, error)
      values (${userId}::uuid, ${p.id}::uuid, 'skipped', ${reason})
      on conflict (user_id, vacancy_id) do nothing`;
  } else {
    await sql`
      insert into notifications_sent (user_id, ad_id, status, error)
      values (${userId}::uuid, ${p.id}::uuid, 'skipped', ${reason})
      on conflict (user_id, ad_id) where ad_id is not null do nothing`;
  }
}

/** Per-user daily budget state for this run: the chosen cap (null = no limit) + DMs already sent today. */
interface DailyBudget {
  cap: number | null;
  letters: number;
}

/**
 * ONE query for the whole run (explicitly not N+1): for every candidate user, their notify_daily_cap
 * and the number of notification DMs already delivered to them since Asia/Seoul midnight.
 *
 * Counting rule: notifications_sent stores one row PER OFFER, while a grouped DM covers up to
 * notify_group_cap offers and shares a single tg_message_id — so LETTERS = count(distinct
 * tg_message_id) over successful rows. Rows without a message id (a rare 'sent' whose Bot API reply
 * carried no message_id) are not counted; erring towards one DM too many beats silently muting a user.
 *
 * The cap column is read through to_jsonb(s) so this query also works on a database where
 * draft_0026 has not been applied yet: the missing key yields NULL = no limit = today's behaviour.
 * The whole thing is best-effort — any fault degrades to "no caps at all" rather than stopping mail.
 */
async function loadDailyBudgets(sql: Sql, userIds: string[]): Promise<Map<string, DailyBudget>> {
  const out = new Map<string, DailyBudget>();
  if (userIds.length === 0) return out;
  try {
    const rows = (await sql`
      select s.user_id::text as user_id,
             (to_jsonb(s) ->> 'notify_daily_cap')::int as cap,
             coalesce(n.letters, 0)::int as letters
      from subscriptions s
      left join (
        select user_id, count(distinct tg_message_id)::int as letters
        from notifications_sent
        where user_id = any(${userIds}::uuid[])
          and status = 'sent'
          and tg_message_id is not null
          and sent_at >= (date_trunc('day', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul')
        group by user_id
      ) n on n.user_id = s.user_id
      where s.user_id = any(${userIds}::uuid[])`) as unknown as {
      user_id: string;
      cap: number | null;
      letters: number | null;
    }[];
    for (const r of rows) out.set(r.user_id, { cap: r.cap ?? null, letters: r.letters ?? 0 });
  } catch {
    // Missing column (deploy-before-migration) or a transient DB fault: fall through with an empty
    // map, i.e. nobody is capped. Failing OPEN here is intentional — a cap fault must never turn
    // into "no notifications at all".
    // eslint-disable-next-line no-console
    console.error('[notify] daily-cap lookup failed (proceeding uncapped)');
  }
  return out;
}

/** Add one matched position to a user's DM bucket, creating the bucket on first sighting. */
function collect(map: Map<string, Recipient>, userId: string, telegramId: string, p: Position): void {
  const cur = map.get(userId);
  if (cur) cur.positions.push(p);
  else map.set(userId, { telegramId, positions: [p] });
}

export async function runNotify(): Promise<NotifyResult> {
  if (!(await getConfigBool('notify_enabled', true))) return { vacancies: 0, ads: 0, sent: 0, capped: 0 };

  const sql = getSql();

  // GEO-less items are never pushed — clear their pending flag so they aren't rescanned every tick.
  // MULTI-GEO (regions wave): the guard softens from "no city" to "no geo AT ALL" — an offer with ANY
  // city OR ANY region is now pushable (matched below by city overlap OR region overlap), so we only
  // clear pending on rows with EMPTY city_ids AND EMPTY region_slugs.
  await sql`update vacancies set notify_pending = false where notify_pending and cardinality(city_ids) = 0 and cardinality(region_slugs) = 0`;
  await sql`update user_ads set notify_pending = false where notify_pending and cardinality(city_ids) = 0 and cardinality(region_slugs) = 0`;

  const batch = await getConfigNumber('notify_vacancy_batch', 10);
  const sendCap = await getConfigNumber('notify_send_cap', 200); // messages per run
  const groupCap = await getConfigNumber('notify_group_cap', 6); // items (buttons) per DM
  const appUrl = process.env.APP_URL;

  // ── 1. Fetch this tick's pending items (same permissive scope, order, and batch as before) ───
  // MULTI-CITY: carry the full city_ids set (used for the subscriber overlap match below). The
  // DISPLAY city is the PRIMARY city_id, or — when a repost never set a primary — the first of
  // city_ids (coalesce(city_id, city_ids[1])); the join is LEFT so a row is never dropped for a
  // null primary. The gard above already cleared pending on city-less (cardinality=0) rows.
  const vacs = (await sql`
    select v.id, v.work_type, v.city_id, v.city_ids, v.region_slugs, c.name as city_name, v.salary_text,
           v.visa_types, v.placement_fee, v.has_housing, v.has_meals
    from vacancies v left join cities c on c.id = coalesce(v.city_id, v.city_ids[1])
    where v.notify_pending and v.is_active and v.duplicate_of is null
    order by v.first_seen_at asc
    limit ${batch}`) as unknown as VacRow[];

  const ads = (await sql`
    select a.id, a.work_type, a.city_id, a.city_ids, a.region_slugs, c.name as city_name, a.salary_text,
           a.visa_types, a.placement_fee, a.has_housing, a.has_meals, a.author_user_id
    from user_ads a left join cities c on c.id = coalesce(a.city_id, a.city_ids[1])
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
  // PER-USER DAILY CAP: one grouped lookup for every candidate of this run (no N+1), then a purely
  // in-memory decision per user. Users with no subscription row here, or with cap NULL, are unlimited.
  const budgets = await loadDailyBudgets(sql, [...byUser.keys()]);

  let sent = 0;
  let capped = 0;
  for (const [userId, rcpt] of byUser) {
    if (sent >= sendCap) break; // per-run message cap: untouched users stay pending, resume next tick

    // Over their own daily budget → send nothing and CLOSE these offers for them (recordSkipped
    // with 'daily_cap'), so the batch keeps draining for everyone else. See recordSkipped's header
    // for why re-queueing them instead would stall the whole cron. Does not consume the run's
    // sendCap: no Bot API call happens.
    const budget = budgets.get(userId);
    const cap = budget?.cap ?? null;
    if (isOverDailyCap(budget?.letters ?? 0, cap)) {
      capped += 1;
      for (const p of rcpt.positions) await recordSkipped(sql, userId, p, 'daily_cap');
      continue;
    }

    const included = rcpt.positions.slice(0, groupCap);
    const { text, extra } = buildUserMessage(included, appUrl);
    const r = await classifySend(rcpt.telegramId, text, extra);

    if (r.kind === 'sent') {
      sent += 1;
      if (budget) budget.letters += 1; // keep the budget honest if a user ever gets two DMs in a run
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
  // (this run or earlier). Items still awaiting someone — groupCap overflow, a deferred/rate-limited
  // or never-processed user — keep the flag and are picked up next tick. Robust to mid-run
  // subscription changes, and correct however the send loop ended (cap/break included).
  // A user skipped by their PERSONAL daily cap already has a 'skipped'/'daily_cap' row, so the
  // `not exists` in vacSubs/adSubs no longer counts them and the item can retire normally — that
  // is what keeps a capped subscriber from freezing the queue for everyone else.
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

  return { vacancies: vacs.length, ads: ads.length, sent, capped };
}
