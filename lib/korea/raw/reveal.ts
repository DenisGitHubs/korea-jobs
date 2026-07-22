// lib/korea/raw/reveal.ts
//
// POST /api/raw/reveal — reveal the ORIGINAL (non-scrubbed) text of ONE "UNVERIFIED" raw
// message on explicit user action, so the contact the AUTHOR wrote inline can be read.
//
// Why: the UNVERIFIED stream (GET /api/raw) scrubs contacts out of the text and never
// exposes a contact, so a phone/@handle the author put in their own post cannot be seen
// there. This endpoint gives it back — but GATED exactly like the vacancy contact reveal.
//
// SECURITY (007):
//   * Auth is the SAME initData gate as every mini-app endpoint (authenticate()); the
//     acting user id comes ONLY from the verified token, NEVER from the body.
//   * The row must be in the SAME whitelist as GET /api/raw (pending ∪ skipped+low_confidence,
//     not yet a vacancy, inside the freshness window). A foreign / invalid / aged-out id -> 404.
//   * Under the SHARED per-user daily reveal cap (contact_reveal_daily_cap) counted across
//     vacancy + user-ad + raw reveals (reveals24h), plus an audit row (raw_contact_reveals).
//     A repeat reveal of the same id is free (unique (user_id, raw_id)) and NOT re-counted.
//   * We return ONLY the original message text. source_id / tg_chat_id / sender_id /
//     sender_username / raw payload are NEVER selected — the source does not leak (007).
//   * NO referral accrual here (unlike vacancy/ad contact reveal): an UNVERIFIED reveal is a
//     low-signal action and must not become a referral-farming lever (owner/Дэн 2026-07-18).

import { getSql } from '../core/db.js';
import { type ReqLike, type ResLike, send, sendError, readJsonBody } from '../core/http.js';
import { ApiErrorCode } from '../core/errors.js';
import { authenticate } from '../core/context.js';
import { getConfigNumber } from '../config.js';
import { reveals24h } from '../vacancies/read.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/raw/reveal — body { raw_id }. Returns { id, text } with the ORIGINAL (NOT
 * scrubbed) text of an UNVERIFIED raw message, under the shared daily reveal cap + audit.
 */
export async function rawReveal(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET').toUpperCase() !== 'POST') return sendError(res, ApiErrorCode.NotFound);
  const auth = await authenticate(req);
  if (!auth.ok) return sendError(res, ApiErrorCode.Unauthorized);

  const body = (await readJsonBody(req)) as { raw_id?: unknown } | null;
  const rawId = typeof body?.raw_id === 'string' ? body.raw_id : null;
  // A missing / non-UUID raw_id is a client error. A well-formed but absent/foreign id is a
  // not-found below (after the whitelist lookup), so a bad id can never masquerade as "empty".
  if (!rawId || !UUID_RE.test(rawId)) return sendError(res, ApiErrorCode.BadRequest);

  try {
    const sql = getSql();
    // Same freshness window as the GET stream (clamped >= 1 like read.ts), so a row that has
    // aged out of the UNVERIFIED feed is not revealable either.
    const maxAge = Math.max(1, Math.floor(await getConfigNumber('raw_max_age_days', 14)));
    const cap = await getConfigNumber('contact_reveal_daily_cap', 50);

    // Whitelist EXACTLY like GET /api/raw: pending ∪ skipped+low_confidence (with a non-NULL
    // confidence — the AI-judged first copy; a cached low_confidence REPEAT is a pre-AI skip with
    // NULL confidence and is NOT in the tab, so it must not be revealable either — owner 2026-07-22,
    // "остаток-3"), not yet a vacancy, inside the freshness window, and NOT a copy of an
    // already-published vacancy (the same already-published guard as the list — else a delisted row
    // would stay revealable by a remembered id; Оля, gate 19.07). Source columns NEVER selected (007).
    const rows = (await sql`
      select id, text
      from raw_messages
      where id = ${rawId}::uuid
        and vacancy_id is null
        and (status = 'pending'
             or (status = 'skipped' and reject_reason = 'low_confidence' and confidence is not null))
        and fetched_at > now() - make_interval(days => ${maxAge})
        and (text_hash is null or not exists (
          select 1 from raw_messages p
          where p.text_hash = raw_messages.text_hash
            and p.status = 'parsed' and p.vacancy_id is not null))
      limit 1`) as unknown as { id: string; text: string | null }[];
    const row = rows[0];
    // Not in the UNVERIFIED whitelist (foreign / already a vacancy / junk / aged out) -> 404.
    if (!row) return sendError(res, ApiErrorCode.NotFound);

    // CONTACTLESS GUARD (owner rule 2026-07-22, twin of vacancyContact): an EMPTY message has nothing to
    // reveal — never record an audit row or charge the shared daily budget for it. Budget is only READ
    // (never charged) to echo the current remaining. Guard runs BEFORE the already-check / insert.
    if (!row.text || row.text.trim() === '') {
      const used = await reveals24h(sql, auth.user.id);
      return send(res, 200, { id: row.id, text: '', reveals_left: Math.max(0, cap - used) });
    }

    // Charge the SHARED budget only the FIRST time this user reveals this row; a repeat reveal
    // is free (unique (user_id, raw_id)) and never re-counted (mirrors contact_reveals).
    let used: number;
    const already = await sql`
      select 1 from raw_contact_reveals
      where user_id = ${auth.user.id}::uuid and raw_id = ${rawId}::uuid limit 1`;
    if (already.length === 0) {
      used = await reveals24h(sql, auth.user.id);
      if (used >= cap) return sendError(res, ApiErrorCode.RateLimited);
      await sql`
        insert into raw_contact_reveals (user_id, raw_id) values (${auth.user.id}::uuid, ${rawId}::uuid)
        on conflict (user_id, raw_id) do nothing`;
      used += 1; // this reveal now counts against the shared daily budget
    } else {
      used = await reveals24h(sql, auth.user.id);
    }

    // Original, non-scrubbed text (contains the contact the author wrote) + the client's remaining budget.
    return send(res, 200, { id: row.id, text: row.text, reveals_left: Math.max(0, cap - used) });
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}
