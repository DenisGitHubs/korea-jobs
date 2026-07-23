// lib/korea/cooperation/rw.ts
//
// POST /api/cooperation — "Сотрудничество" enquiry. We persist the request
// (cooperation_requests) for audit AND DM the configured admins so a new enquiry is not lost
// (owner rule, 2026-07-23). Auth via initData. The CONTACT is the requester's OWN Telegram
// account, derived from the verified identity — the app already knows who is asking, so the
// form no longer asks the user to type it in. The admin DM is best-effort: a notify failure
// never breaks the 200 (the row is already committed for audit).

import { getSql } from '../core/db.js';
import { type ReqLike, type ResLike, send, sendError, readJsonBody } from '../core/http.js';
import { ApiErrorCode } from '../core/errors.js';
import { authenticate } from '../core/context.js';
import { adminRecipients } from '../admin/auth.js';
import { sendMessage } from '../bot/telegram.js';

const MAX_MESSAGE_LEN = 2_000;

interface Body {
  message?: unknown;
}

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

export async function cooperationPost(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') return sendError(res, ApiErrorCode.NotFound);
  const auth = await authenticate(req);
  if (!auth.ok) return sendError(res, ApiErrorCode.Unauthorized);

  const body = (await readJsonBody(req)) as Body | null;
  const message = str(body?.message, MAX_MESSAGE_LEN);
  if (!message) return sendError(res, ApiErrorCode.BadRequest, 'message is required');

  try {
    const sql = getSql();
    // Contact = the requester's own Telegram handle from the verified identity (never a
    // user-typed field). Prefer @username; fall back to a tg:// deep link by id so the
    // owner can always reach whoever sent the enquiry, even without a public username.
    const urows = (await sql`
      select username, telegram_id from users where id = ${auth.user.id}::uuid limit 1`) as unknown as {
      username: string | null;
      telegram_id: string | number | null;
    }[];
    const uname = urows[0]?.username ?? null;
    const tgid = urows[0]?.telegram_id ?? null;
    const contact = uname ? '@' + uname : tgid != null ? 'tg://user?id=' + tgid : null;

    await sql`
      insert into cooperation_requests (user_id, contact, message)
      values (${auth.user.id}::uuid, ${contact}, ${message})`;

    // Best-effort: DM the owner/admins about the new enquiry. Wrapped so that NOTHING here can
    // throw past the 200 — the request is already persisted, so a notify fault must not turn a
    // saved enquiry into a 500. The message is the requester's text (data, forwarded as-is) and
    // is sent as plain text (no parse_mode), so it cannot inject Telegram markup.
    try {
      const ids = await adminRecipients(sql);
      if (ids.length > 0) {
        const dm = `📩 Новая заявка на сотрудничество\n\nКонтакт: ${contact ?? '—'}\n\n${message}`;
        for (const id of ids) {
          try {
            await sendMessage(id, dm);
          } catch {
            // eslint-disable-next-line no-console
            console.error('[cooperation] admin notify failed');
          }
        }
      }
    } catch {
      // eslint-disable-next-line no-console
      console.error('[cooperation] admin notify skipped');
    }

    send(res, 200, { ok: true });
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}
