// lib/korea/admin/erase.ts
//
// POST /api/admin/erase-user — ADMIN. «Удалим данные по запросу» made executable.
//
// WHY THIS EXISTS
// The Privacy Policy promises TWO things: «напиши нам @korea_rabota_bot … мы отвечаем и выполняем
// просьбу об удалении в течение 3 рабочих дней». The answering half arrived with bot/inbox.ts; this
// is the doing half. Without it the owner would have to execute a deletion request by hand in the
// production database — and the obvious hand-written statement, `delete from users where
// telegram_id = …`, is a TRAP: referral_activations cascades from users and referral_points_ledger
// cascades from referral_activations, so deleting one person silently shrinks the balance of the
// INVITER who brought them (see the scheme in cleanup/inactive.ts).
//
// So this endpoint does NOT invent an erasure. It calls eraseUsers() — the exact same function,
// statements and order the automatic 12-month sweep uses — on one named account. One
// implementation, one place to audit, no chance of the manual path diverging from the tested one.
//
// HOW THE OWNER IDENTIFIES THE PERSON — telegram_id, AND NOTHING ELSE.
// Every request arrives through the bot, and the forwarded DM carries the sender's id on its
// header line («От: … · id 555»), so the owner copies a number he already has in front of him.
// That id came from Telegram itself on a verified update — it is a PROOF of who asked.
//
// Two identifiers that look convenient are refused on purpose, because an irreversible action may
// only be keyed on something both immutable AND non-public:
//   * username — a @handle can be released and re-registered by a different person, so erasing
//     "by @name" could wipe an innocent account.
//   * public_id — the 16-hex referral code. It is not a secret and not a proof: the person
//     PUBLISHES it themselves inside their invite link (?startapp=<code>, see bot/webhook.ts), so
//     anyone who ever saw that link could write «удалите мои данные, мой код X» and we would
//     irreversibly erase a STRANGER — and the Policy promises to do it «без лишних вопросов».
//     A request that quotes only an invite link is answered by asking the person to write from
//     their own account; the bot then hands us their real telegram_id.
//
// A PERSON WITH NO ACCOUNT. Someone can write to the bot without ever opening the Mini App — then
// there is no users row and everything we hold about them is the two telegram-id ledgers
// (bot_updates, bot_inbox). The lookup ALWAYS clears those, whether or not an account was found,
// so "delete my data" is honest for them too. The response says which case it was.
//
// SAFETY
//   * requireAdmin (Bearer CRON_SECRET or an admin's Mini App initData) — same gate as takedown.
//   * dry_run: true reports what exists without writing a thing.
//   * An ADMIN account is refused (a mistyped id must not erase the owner himself). "Admin" means
//     ALL THREE of the things auth.ts recognises, and they are independent lists: the env
//     ADMIN_TELEGRAM_IDS, the caller's own account, and users.role='admin'. The first two are
//     checked twice — on the requested id before any DB read, and again on the id of the row that
//     was actually resolved — so the guarantee cannot depend on how the target was looked up.
//   * Idempotent: an already-erased account has no telegram_id left, so a repeat call simply finds
//     nobody (found: false) and reports zero counts.
//   * The response carries counts only — never a name, a phone or a message.

import { getSql } from '../core/db.js';
import { type ReqLike, type ResLike, send, sendError, readJsonBody } from '../core/http.js';
import { ApiErrorCode } from '../core/errors.js';
import { requireAdmin, isAdminTelegramId } from './auth.js';
import { eraseUsers, eraseBotLedgers, emptyEraseCounts, type EraseCounts } from '../cleanup/inactive.js';

/** Telegram ids are positive and fit in a bigint (≤ 19 digits). */
const TELEGRAM_ID_RE = /^[1-9][0-9]{0,18}$/;

interface Body {
  telegram_id?: unknown;
  dry_run?: unknown;
  /**
   * NOT an accepted identifier (see the header). It stays in the shape for ONE reason: a caller
   * who still sends it must get a loud, explanatory 400 instead of a silently ignored field that
   * would erase whoever `telegram_id` happened to be — or nobody at all.
   */
  public_id?: unknown;
}

/** Accept a number or a digit string; anything else (incl. "@name", "id 555") is refused. */
export function normalizeTelegramId(v: unknown): string | null {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? String(v) : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return TELEGRAM_ID_RE.test(s) ? s : null;
}

interface UserRow {
  id: string;
  tid: string | null;
  role: string | null;
}

export async function adminEraseUser(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') return sendError(res, ApiErrorCode.NotFound);
  const admin = await requireAdmin(req);
  if (!admin.ok) return sendError(res, ApiErrorCode.Unauthorized);

  const body = (await readJsonBody(req)) as Body | null;
  const telegramId = normalizeTelegramId(body?.telegram_id);
  const dryRun = body?.dry_run === true;

  // A public referral code is not a proof of identity — refused BEFORE anything else, and with a
  // detail that says what to do instead, so an old script cannot get a confusing "required" error.
  if (body?.public_id !== undefined) {
    return sendError(
      res,
      ApiErrorCode.BadRequest,
      'public_id is not accepted (it is a public referral code, not a proof of identity) — pass telegram_id from the forwarded DM header',
    );
  }
  if (!telegramId) {
    return sendError(
      res,
      ApiErrorCode.BadRequest,
      'telegram_id required — a positive numeric id (the «id …» in the forwarded DM header), not a @username',
    );
  }

  // Never erase an admin, part 1 — on the REQUESTED id, before any DB read: the env list
  // (ADMIN_TELEGRAM_IDS) and the account the caller is authenticated as. Part 2 runs below on the
  // row that was actually resolved; the DB role is checked there too.
  if (isAdminTelegramId(telegramId)) {
    return sendError(res, ApiErrorCode.BadRequest, 'admin account');
  }
  if (admin.via === 'user' && admin.user.telegramId === telegramId) {
    return sendError(res, ApiErrorCode.BadRequest, 'admin account');
  }

  try {
    const sql = getSql();

    // LIVE accounts only (deleted_at is null): an already-erased row has no identifiers left, so
    // this simply finds nobody and the call reports "found: false" instead of erasing twice.
    const rows = (await sql`
      select id, telegram_id::text as tid, role from users
      where telegram_id = ${telegramId}::bigint and deleted_at is null limit 1`) as unknown as UserRow[];
    const user = rows[0] ?? null;

    // Never erase an admin, part 2 — on the RESOLVED row, so the guarantee holds no matter how the
    // person was found. auth.ts recognises admins by THREE independent things (env list, the
    // caller's own account, users.role='admin'): an env admin can perfectly well carry role='user'
    // in the DB, so checking the role alone would leave a hole.
    const tid = user?.tid ?? null;
    const isAdminRow =
      user?.role === 'admin' ||
      (tid !== null &&
        (isAdminTelegramId(tid) || (admin.via === 'user' && admin.user.telegramId === tid)));
    if (isAdminRow) return sendError(res, ApiErrorCode.BadRequest, 'admin account');

    if (dryRun) {
      return send(res, 200, {
        ok: true,
        dryRun: true,
        found: user !== null,
        counts: emptyEraseCounts(),
      });
    }

    let counts: EraseCounts;
    if (user) {
      counts = await eraseUsers(sql, [{ id: user.id, tid: user.tid }]);
    } else {
      // No account — but we may still hold bot ledger rows keyed on that telegram id. Clear them,
      // so «удалите мои данные» is honest for someone who only ever wrote to the bot.
      counts = { ...emptyEraseCounts(), ...(await eraseBotLedgers(sql, [telegramId])) };
    }

    // Audit line: counts only, no identifiers (the request itself lives in the admin's Telegram).
    // eslint-disable-next-line no-console
    console.log(
      `[admin] erase-user: users=${counts.usersErased} ads=${counts.adsDeleted} ` +
        `subs=${counts.subscriptionsDeleted} bot_updates=${counts.botUpdatesDeleted} ` +
        `bot_inbox=${counts.botInboxDeleted}`,
    );

    send(res, 200, { ok: true, found: user !== null, counts });
  } catch (err) {
    sendError(res, ApiErrorCode.Internal, 'erase_failed', err);
  }
}
