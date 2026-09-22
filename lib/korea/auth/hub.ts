// lib/korea/auth/hub.ts
//
// POST /api/auth/hub — THE EXCHANGE WINDOW of the second door. Body { hub_ticket },
// answer { token, expires_at }: an AppHub Studio ticket (60 s, signed by the hub) is
// traded ONCE for our own session pass (a day, signed by us). Every later request from
// the shell carries `Authorization: kjs <token>` and never the ticket again.
//
// This is the ONLY caller of verifyHubTicket, and the only place a pass is minted.
//
// WHAT THIS HANDLER PROMISES
//   * 400 — the field is missing, is not a string, or is longer than the ticket cap.
//           A shape complaint, nothing about the ticket's contents.
//   * 401 — ANY refusal by the ticket itself, all thirteen of them under ONE answer.
//           🔴 The machine reason goes to OUR LOG AND NOWHERE ELSE: told which check it
//           tripped, a probe would tune its next attempt (and would learn, for free,
//           whether a given telegram id exists).
//   * 503 — the hub public key is unset or is not an Ed25519 key. NOT 401: the fault is
//           ours, and answering "your ticket is bad" would send a person to reinstall an
//           app over our own typo (core/hub-ticket.ts, invariant 8).
//   * 200 — { token, expires_at }. The pass and the ticket are never logged, and neither
//           is the telegram_id: a SUCCESS logs `jti` only.
//
// 🔴 WHY `jti` IS IN THE SUCCESS LINE AT ALL. Without it a log shows only "somebody got
// in", so a thief's login and the owner's are literally the same line (fix №3 of the 007
// review, 23.09.2026). `jti` is the hub's own ticket id, so an incident is read by putting
// the two logs side by side — and it identifies the TICKET, not the person.
//
// NOTE: no rate limit here. The gate is the hub's signature — an attempt without a valid
// one costs the attacker a signature he cannot produce, and an in-memory counter on
// serverless would limit nothing anyway (skill serverless-inmemory-rate-limit-void.md).

import { type ReqLike, type ResLike, readJsonBody, send, sendError } from '../core/http.js';
import { ApiErrorCode } from '../core/errors.js';
import {
  HUB_TICKET_MAX_CHARS,
  HUB_TICKET_PUBLIC_KEY_ENV,
  verifyHubTicket,
} from '../core/hub-ticket.js';
import { mintHubSession } from '../core/hub-session.js';

export async function authHubPost(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') return sendError(res, ApiErrorCode.NotFound);

  const body = (await readJsonBody(req)) as { hub_ticket?: unknown } | null;
  const ticket = body?.hub_ticket;
  if (typeof ticket !== 'string' || ticket.length === 0 || ticket.length > HUB_TICKET_MAX_CHARS) {
    // Shape only — said before a single byte of the value is looked at.
    return sendError(res, ApiErrorCode.BadRequest, 'hub_ticket');
  }

  let verified;
  try {
    verified = await verifyHubTicket(ticket);
  } catch (err) {
    // verifyHubTicket promises never to throw (invariant 9). If that promise is ever
    // broken, the door still must not crash the request — and the breach must be visible.
    return sendError(res, ApiErrorCode.Internal, 'hub_ticket_threw', err);
  }

  if (!verified.ok) {
    // ONE LINE PER REFUSAL (fix №11 of the review, 23.09.2026). The verifier used to print
    // its own line for a missing key while this one printed the reason, so a single refusal
    // read as two events. The MODULE now prints nothing and returns a machine word; the
    // DOOR prints — and for the configuration fault it adds the NAME of the variable (never
    // its value, never the ticket), which is the only thing that line is for.
    const where =
      verified.reason === 'not_configured'
        ? ` (${HUB_TICKET_PUBLIC_KEY_ENV} is missing or holds no Ed25519 public key)`
        : '';
    // eslint-disable-next-line no-console
    console.error(`[auth/hub] refused: ${verified.reason}${where}`);
    if (verified.reason === 'not_configured') {
      return sendError(res, ApiErrorCode.ServiceUnavailable);
    }
    return sendError(res, ApiErrorCode.Unauthorized);
  }

  const botToken = process.env.BOT_TOKEN;
  if (!botToken) {
    // Same class as a missing hub key: OUR setup, not the caller's ticket.
    // eslint-disable-next-line no-console
    console.error('[auth/hub] refused: BOT_TOKEN is not set');
    return sendError(res, ApiErrorCode.ServiceUnavailable);
  }

  const { telegramId, jti, language } = verified.identity;
  let pass: { token: string; expiresAt: number };
  try {
    // The `jti` travels INTO the pass (core/hub-session.ts, invariant 7): without it the
    // success line below joins to nothing later on, and two sessions minted from one
    // replayed ticket are indistinguishable from each other and from an honest one.
    pass = mintHubSession(telegramId, language, jti, botToken);
  } catch (err) {
    // mintHubSession throws only on OUR faults (a pass we would not accept ourselves —
    // e.g. one grown past HUB_SESSION_MAX_CHARS). Never a 200 with a token that dies on
    // the next request; a loud, traceable 500 instead.
    return sendError(res, ApiErrorCode.Internal, 'hub_session_mint', err);
  }

  // Exactly this and nothing more: no ticket, no pass, no telegram_id, no key.
  // eslint-disable-next-line no-console
  console.log(`[auth/hub] ok jti=${jti}`);

  // The user row is NOT created here. It is created by the first authenticated call the
  // shell makes with this pass (core/context.ts, the kjs branch) — one place that writes
  // to users, whichever door a visitor came through.
  send(res, 200, { token: pass.token, expires_at: pass.expiresAt });
}
