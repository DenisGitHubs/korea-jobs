// lib/korea/admin/takedown.ts
//
// POST /api/admin/takedown-contact — ADMIN. «Уберите мой номер из объявления» for a person who is
// NOT in our database.
//
// WHY THIS EXISTS
// The Privacy Policy tells THIRD PARTIES — an employer or recruiter whose phone we picked up from
// a foreign Telegram chat — to write to the bot: «увидел в приложении свой контакт … напиши нам
// со ссылкой на объявление или его описанием. Мы уберём контакт в течение 3 рабочих дней». Such a
// person has no account, so the account-erasure endpoint (admin/erase.ts) is meaningless for them:
// their data is not in `users`, it is inside VACANCY CARDS.
//
// The per-card tool already existed (POST /api/vacancies/:id/takedown) but needs the card's UUID.
// What actually arrives in the bot is a phone number, a @handle, or a share link — never a UUID.
// This endpoint closes exactly that gap: give it what the person sent, and it takes down EVERY
// card carrying that contact in one call.
//
// WHAT IT DOES (same semantics as the per-card takedown, applied to a set)
//   1. Resolves the target set:
//        * `contact` — normalized through kj_normalize_contact (the SAME function that generates
//          vacancies.contact_normalized and the dedup hash), so "010-1234-5678", "+82 10 1234
//          5678" and "01012345678" all resolve to one key;
//        * `vacancy` — a card reference in any shape the owner may have to hand: a dashed UUID,
//          the 32-hex form, or a share deep link («?startapp=v<32hex>r<ref>»). Its own contact is
//          then used as the contact key too, so "take down this card" also means "and every other
//          card with the same phone" — which is what the person is actually asking for.
//   2. RECORDS a `takedowns` row per distinct content_hash FIRST, then deactivates the cards. That
//      order is deliberate: the takedown list is what stops the parser from re-inserting the same
//      posting later and what cleanup re-enforces every tick, so even if the update below failed,
//      the content would still be blocked and the next cleanup tick would darken it.
//   3. Takes down matching USER ADS as well (status='taken_down'), because someone may have typed
//      a third party's phone into an ad they posted here.
//
// HOW STRONG THE BLOCK IS. content_hash = contact | city | work_type | gender | dedup_extra — the
// description is NOT part of it. So a takedown blocks not only a byte-identical repost but any
// REWORDED repost of the same offer from the same contact. What it does NOT block is the same
// phone appearing in a genuinely different offer (another city or another kind of work): that is a
// new publication with a new hash, and it can be taken down the same way.
//
// SAFETY
//   * requireAdmin (Bearer CRON_SECRET or an admin's Mini App initData).
//   * dry_run: true only COUNTS what would be affected — the owner sees the blast radius first.
//   * Reversible if ever needed: `delete from takedowns where content_hash = …` +
//     `update vacancies set is_active = true where …`. Nothing is physically deleted here.
//   * The response carries counts, never the contact or any card text.

import { getSql } from '../core/db.js';
import { type ReqLike, type ResLike, send, sendError, readJsonBody } from '../core/http.js';
import { ApiErrorCode } from '../core/errors.js';
import { requireAdmin } from './auth.js';

const MAX_REASON_LEN = 500;
const MAX_CONTACT_LEN = 200;
/**
 * Same idea as the two caps above, applied to the card reference: every shape we accept is short
 * (a dashed UUID is 36 chars, a share deep link ~120), so 500 leaves room for the line the owner
 * pasted around the link while keeping the three regexes below off an unbounded string.
 */
const MAX_VACANCY_LEN = 500;

const UUID_DASHED_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** The share deep-link form: v<32 hex> (optionally followed by r<16 hex>). */
const SHARE_HEX_RE = /v([0-9a-f]{32})(?![0-9a-f])/i;
const BARE_HEX32_RE = /^[0-9a-f]{32}$/i;

interface Body {
  contact?: unknown;
  vacancy?: unknown;
  reason?: unknown;
  dry_run?: unknown;
}

/**
 * Turn whatever the owner pasted into a canonical dashed UUID: a dashed UUID anywhere in the
 * string, a share link's `v<32hex>` payload, or a bare 32-hex id. Returns null when there is none.
 * The input is capped at MAX_VACANCY_LEN first — the same discipline `contact` and `reason` get.
 */
export function parseVacancyRef(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().slice(0, MAX_VACANCY_LEN);
  if (!s) return null;

  const dashed = UUID_DASHED_RE.exec(s);
  if (dashed) return dashed[0].toLowerCase();

  // `v<32hex>` from a share link — checked before the bare form so "…startapp=v<hex>r<ref>" works.
  const share = SHARE_HEX_RE.exec(s);
  const hex = share ? share[1]! : BARE_HEX32_RE.test(s) ? s : null;
  if (!hex) return null;
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export async function contactTakedown(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') return sendError(res, ApiErrorCode.NotFound);
  const admin = await requireAdmin(req);
  if (!admin.ok) return sendError(res, ApiErrorCode.Unauthorized);

  const body = (await readJsonBody(req)) as Body | null;
  const contactRaw =
    typeof body?.contact === 'string' && body.contact.trim()
      ? body.contact.trim().slice(0, MAX_CONTACT_LEN)
      : null;
  const vacancyId = parseVacancyRef(body?.vacancy);
  const reason = typeof body?.reason === 'string' ? body.reason.slice(0, MAX_REASON_LEN) : 'contact_takedown';
  const dryRun = body?.dry_run === true;

  if (!contactRaw && !vacancyId) {
    return sendError(res, ApiErrorCode.BadRequest, 'contact or vacancy required');
  }

  try {
    const sql = getSql();

    // Resolve the contact key. kj_normalize_contact is the SAME function behind
    // vacancies.contact_normalized and the dedup hash, so the key can never drift from the column
    // we match on. A non-contact-looking string yields NULL — then only the named card is affected.
    let norm: string | null = null;
    if (contactRaw) {
      const r = (await sql`select kj_normalize_contact(${contactRaw}::text) as norm`) as unknown as {
        norm: string | null;
      }[];
      norm = r[0]?.norm ?? null;
    }

    // A named card contributes its OWN contact to the key: "remove my number from this ad" means
    // every card with that number, not just the one the person happened to link.
    let vacancyFound = false;
    if (vacancyId) {
      const r = (await sql`
        select contact_normalized from vacancies where id = ${vacancyId}::uuid limit 1`) as unknown as {
        contact_normalized: string | null;
      }[];
      if (r.length === 0) return sendError(res, ApiErrorCode.NotFound, 'vacancy not found');
      vacancyFound = true;
      if (!norm) norm = r[0]?.contact_normalized ?? null;
    }

    if (dryRun) {
      const v = (await sql`
        select count(*)::int as total, (count(*) filter (where is_active))::int as active
        from vacancies
        where (${norm}::text is not null and contact_normalized = ${norm}::text)
           or (${vacancyId}::uuid is not null and id = ${vacancyId}::uuid)`) as unknown as {
        total: number;
        active: number;
      }[];
      const a = (await sql`
        select count(*)::int as total from user_ads
        where ${norm}::text is not null
          and status <> 'taken_down'
          and kj_normalize_contact(contact_raw) = ${norm}::text`) as unknown as { total: number }[];
      return send(res, 200, {
        ok: true,
        dryRun: true,
        contactMatched: norm !== null,
        vacancyFound,
        wouldAffect: {
          vacancies: v[0]?.total ?? 0,
          activeVacancies: v[0]?.active ?? 0,
          ads: a[0]?.total ?? 0,
        },
      });
    }

    // (1) Register the block FIRST — one row per distinct content_hash, never a duplicate. The
    //     `distinct on` matters: two cards can share a hash (only ONE of them can be active), and
    //     `not exists` cannot see rows inserted by the same statement.
    const recorded = await sql`
      with target as (
        select distinct on (v.content_hash)
               v.content_hash, v.contact_normalized, v.source_id, v.raw_message_id
        from vacancies v
        where (${norm}::text is not null and v.contact_normalized = ${norm}::text)
           or (${vacancyId}::uuid is not null and v.id = ${vacancyId}::uuid)
        order by v.content_hash
      )
      insert into takedowns (content_hash, contact_normalized, source_id, raw_message_id, reason)
      select t.content_hash, t.contact_normalized, t.source_id, t.raw_message_id, ${reason}
      from target t
      where not exists (select 1 from takedowns d where d.content_hash = t.content_hash)
      returning id`;

    // (2) Darken the cards. Cleanup re-enforces this from the takedown list every tick, so even a
    //     failure here self-heals on the next run.
    const deactivated = await sql`
      update vacancies set is_active = false
      where is_active
        and ((${norm}::text is not null and contact_normalized = ${norm}::text)
          or (${vacancyId}::uuid is not null and id = ${vacancyId}::uuid))
      returning id`;

    // (3) User ads carrying the same contact. 'taken_down' is a terminal status the app already
    //     understands (the author cannot edit or revive it).
    const adsTakenDown = norm
      ? await sql`
          update user_ads set status = 'taken_down', reject_reason = 'takedown', moderated_at = now()
          where status <> 'taken_down' and kj_normalize_contact(contact_raw) = ${norm}::text
          returning id`
      : [];

    // Audit line: counts only, never the contact itself.
    // eslint-disable-next-line no-console
    console.log(
      `[admin] takedown-contact: hashes=${recorded.length} vacancies=${deactivated.length} ads=${adsTakenDown.length}`,
    );

    send(res, 200, {
      ok: true,
      contactMatched: norm !== null,
      vacancyFound,
      takedownsRecorded: recorded.length,
      vacanciesDeactivated: deactivated.length,
      adsTakenDown: adsTakenDown.length,
    });
  } catch (err) {
    sendError(res, ApiErrorCode.Internal, 'takedown_failed', err);
  }
}
