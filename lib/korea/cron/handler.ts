// lib/korea/cron/handler.ts
//
// Cron endpoints, authenticated by a shared bearer secret (CRON_SECRET). Called by an
// external scheduler (Vercel Hobby cron can't do minute frequency — Sanya §3/§5.1),
// e.g. Upstash QStash / cron-job.org / GitHub Actions. Each handler is idempotent and
// resumable, so a missed or duplicated tick is harmless.
//
//   POST /api/cron/parse   -> lib/korea/parser/run.ts (AI extraction)
//   POST /api/cron/notify  -> lib/korea/notify/run.ts (realtime per-item push)
//   POST /api/cron/digest  -> lib/korea/digest/run.ts (once-a-day matched-vacancy summary)
//   POST /api/cron/cleanup -> lib/korea/cleanup/run.ts (TTL retention / takedown)

import {
  type ReqLike,
  type ResLike,
  send,
  sendError,
  bearerToken,
  constantTimeEquals,
} from '../core/http.js';
import { ApiErrorCode } from '../core/errors.js';
import { runParse } from '../parser/run.js';
import { runNotify } from '../notify/run.js';
import { runDigest } from '../digest/run.js';
import { runCleanup } from '../cleanup/run.js';
import { runReferralConfirm } from '../referral/confirm.js';

function authorized(req: ReqLike): boolean {
  return constantTimeEquals(bearerToken(req), process.env.CRON_SECRET);
}

function unauthorized(res: ResLike): void {
  res.statusCode = 401;
  res.end('');
}

/** POST /api/cron/parse — run one AI extraction batch. */
export async function cronParse(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') return sendError(res, ApiErrorCode.NotFound);
  if (!authorized(req)) return unauthorized(res);
  try {
    const result = await runParse();
    send(res, 200, { ok: true, ...result });
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}

/** POST /api/cron/notify — push new matching vacancies to subscribers. */
export async function cronNotify(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') return sendError(res, ApiErrorCode.NotFound);
  if (!authorized(req)) return unauthorized(res);
  try {
    const result = await runNotify();
    send(res, 200, { ok: true, ...result });
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}

/** POST /api/cron/digest — send the once-a-day matched-vacancy digest. Self-throttled: it only
 *  acts inside 09:00–12:00 Asia/Seoul and at most once / 22h, so the ~3-min poll is harmless. */
export async function cronDigest(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') return sendError(res, ApiErrorCode.NotFound);
  if (!authorized(req)) return unauthorized(res);
  try {
    const result = await runDigest();
    send(res, 200, { ok: true, ...result });
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}

/** POST /api/cron/cleanup — TTL retention (deactivate stale vacancies, purge old raw). */
export async function cronCleanup(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') return sendError(res, ApiErrorCode.NotFound);
  if (!authorized(req)) return unauthorized(res);
  try {
    const result = await runCleanup();
    send(res, 200, { ok: true, ...result });
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}

/** POST /api/cron/referral-confirm — flip eligible pending referral credits to confirmed
 *  (per-recipient daily cap + L1 diminishing/hard-wall), single-flight guarded. No balance
 *  cache: reads sum the ledger. Returns run counters incl. an oldest-pending stall metric. */
export async function cronReferralConfirm(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') return sendError(res, ApiErrorCode.NotFound);
  if (!authorized(req)) return unauthorized(res);
  try {
    const result = await runReferralConfirm();
    send(res, 200, { ok: true, ...result });
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}
