// lib/korea/stats/read.ts
//
// GET /api/stats — public aggregate scale for the "N вакансий из M чатов" strip.
// tma-authenticated (same as the feed: 401 without valid initData) but NO scope — the
// numbers are public aggregates, not tied to the caller.
//
//   vacancies_count : active, non-duplicate SCRAPED vacancies (the corpus drawn from
//                     source chats). Matches the "N вакансий" framing of the strip.
//   sources_count   : HONEST count of distinct source chats that currently hold at least
//                     one active non-dup vacancy — `count(distinct source_id)`, NOT a
//                     `sources.is_active` count. count(distinct) ignores NULL source_id,
//                     so a vacancy whose source was detached does not inflate it. This
//                     way the strip never claims chats that produced nothing.
//
// Both figures come from ONE snapshot query over the same predicate, so they can never
// drift against each other (M chats always genuinely back the N vacancies).

import { getSql } from '../core/db.js';
import { type ReqLike, type ResLike, send, sendError } from '../core/http.js';
import { ApiErrorCode } from '../core/errors.js';
import { authenticate } from '../core/context.js';

export async function statsGet(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'GET') return sendError(res, ApiErrorCode.NotFound);
  const auth = await authenticate(req);
  if (!auth.ok) return sendError(res, ApiErrorCode.Unauthorized);

  try {
    const sql = getSql();
    const rows = (await sql`
      select
        count(*)::int                  as vacancies_count,
        count(distinct source_id)::int as sources_count
      from vacancies
      where is_active and duplicate_of is null`) as unknown as {
      vacancies_count: number;
      sources_count: number;
    }[];
    const r = rows[0];
    send(res, 200, {
      vacancies_count: r?.vacancies_count ?? 0,
      sources_count: r?.sources_count ?? 0,
    });
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}
