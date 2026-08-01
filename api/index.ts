// api/index.ts
//
// Single serverless entry: ONE Vercel function for the whole API, so the Hobby
// 12-function ceiling is respected. NOTE: filename catch-all ([...path]) is a Next.js
// router feature — on a non-Next.js project Vercel only matches a single path segment
// by filename, so nested /api/a/b would 404 at the platform before reaching us. We
// therefore rewrite  /api/:path*  ->  /api/index?path=:path*  (see vercel.json) and read
// the logical route from req.query.path. Routes are matched by path segments; each thin
// handler owns its own method-routing, auth and status codes.
//
// app/ and api/ deploy as ONE Vercel project (same-origin), so no CORS is needed for
// the Mini App endpoints. The ingest/sources endpoints are server-to-server.
//
// Auth per route group (see architecture.md):
//   /api/ingest, /api/sources                         -> Bearer INGEST_SECRET
//   /api/cities|vacancies|me|subscription|terms|ads|cooperation|referral -> tma <initData>
//   /api/vacancies/:id/takedown, /api/ads/:id/moderate-> admin (CRON_SECRET | ADMIN_TELEGRAM_IDS)
//   /api/admin/erase-user, /api/admin/takedown-contact-> admin (CRON_SECRET | ADMIN_TELEGRAM_IDS)
//   /api/bot/webhook                                  -> X-Telegram-Bot-Api-Secret-Token
//   /api/cron/parse|notify|digest|cleanup|referral-confirm|inactive-erase|scheduled -> Bearer CRON_SECRET
//   /api/media/:id                                    -> PUBLIC (unguessable id + per-request
//                                                        visibility re-check; see the route below)

import { type ReqLike, type ResLike, send, sendError } from '../lib/korea/core/http.js';
import { ApiErrorCode, httpStatusFor, makeError } from '../lib/korea/core/errors.js';
import { sourcesGet, ingestPost } from '../lib/korea/ingest/handler.js';
import {
  cronParse,
  cronNotify,
  cronDigest,
  cronCleanup,
  cronReferralConfirm,
  cronInactiveErase,
  cronScheduled,
} from '../lib/korea/cron/handler.js';
import { botWebhook } from '../lib/korea/bot/webhook.js';
import { citiesGet } from '../lib/korea/cities/read.js';
import {
  vacanciesFeed,
  vacanciesCount,
  vacancyDetail,
  vacancyContact,
  savedFeed,
  vacancySave,
} from '../lib/korea/vacancies/read.js';
import { statsGet } from '../lib/korea/stats/read.js';
import { rawFeed } from '../lib/korea/raw/read.js';
import { rawReveal } from '../lib/korea/raw/reveal.js';
import { vacancyReport } from '../lib/korea/reports/rw.js';
import { vacancyTakedown } from '../lib/korea/vacancies/moderate.js';
import { meGet } from '../lib/korea/users/me.js';
import { onboardedPost } from '../lib/korea/users/onboarded.js';
import { subscriptionPost } from '../lib/korea/subscriptions/rw.js';
import { termsAccept } from '../lib/korea/terms/rw.js';
import { adsCreate, adsMine, adsModerate } from '../lib/korea/ads/rw.js';
import { adBump, adArchive, adUnarchive, adItem } from '../lib/korea/ads/manage.js';
import { cooperationPost } from '../lib/korea/cooperation/rw.js';
import { adminEraseUser } from '../lib/korea/admin/erase.js';
import { contactTakedown } from '../lib/korea/admin/takedown.js';
import { referralGet } from '../lib/korea/referral/read.js';
import { sharePrepare } from '../lib/korea/share/prepare.js';
import { mediaGet } from '../lib/korea/media/read.js';

type Handler = (req: ReqLike, res: ResLike) => Promise<void> | void;

interface Route {
  segments: string[]; // path template; ':id' captures a dynamic value onto req.query.id
  handler: Handler;
}

/** Every endpoint, in its deployed shape (/api/...). Grows as handlers land. */
const ROUTES: Route[] = [
  // Collector <-> backend (bearer secrets)
  { segments: ['sources'], handler: sourcesGet },
  { segments: ['ingest'], handler: ingestPost },
  // Cron (bearer CRON_SECRET)
  { segments: ['cron', 'parse'], handler: cronParse },
  // Mini app (Authorization: tma <initData>)
  { segments: ['cities'], handler: citiesGet },
  // Public aggregate scale for the "N вакансий из M чатов" strip (tma auth, no scope).
  { segments: ['stats'], handler: statsGet },
  { segments: ['vacancies'], handler: vacanciesFeed },
  // The "UNVERIFIED" stream ("не разобрано"): raw messages the parser couldn't confidently
  // turn into a vacancy (tma auth, no scope). Literal single segment — declared before any
  // parametric route so it can never be shadowed. Text is scrubbed; NO contact reveal.
  { segments: ['raw'], handler: rawFeed },
  // Reveal ONE unverified raw message's ORIGINAL text on explicit action (POST, body {raw_id}):
  // shared daily reveal cap + audit; source never leaks. Length-2 literal — no ':id' collision.
  { segments: ['raw', 'reveal'], handler: rawReveal },
  // The caller's own bookmarks ("Сохранённые") as a feed page (tma auth, scope=self).
  { segments: ['saved'], handler: savedFeed },
  // Literal 'count' MUST precede the parametric ':id', else /vacancies/count would match
  // vacancies/:id with id="count" and 404 in vacancyDetail (UUID check).
  { segments: ['vacancies', 'count'], handler: vacanciesCount },
  { segments: ['vacancies', ':id'], handler: vacancyDetail },
  { segments: ['vacancies', ':id', 'contact'], handler: vacancyContact },
  // Save/unsave toggle (POST=save, DELETE=unsave). Literal 'save' third segment, so it
  // never collides with the other ':id' sub-routes.
  { segments: ['vacancies', ':id', 'save'], handler: vacancySave },
  { segments: ['vacancies', ':id', 'report'], handler: vacancyReport },
  // Admin (bearer CRON_SECRET or ADMIN_TELEGRAM_IDS user)
  { segments: ['vacancies', ':id', 'takedown'], handler: vacancyTakedown },
  { segments: ['me'], handler: meGet },
  { segments: ['subscription'], handler: subscriptionPost },
  // One-time onboarding flag (POST; stamps users.onboarded_at, first call wins).
  { segments: ['onboarded'], handler: onboardedPost },
  { segments: ['terms', 'accept'], handler: termsAccept },
  // User ads ("Разместить") + "Мои объявления". Literal 'mine' MUST precede the parametric
  // ['ads', ':id'] (edit/delete), else /ads/mine would match ':id' with id="mine" and 404 in
  // the UUID check. The length-3 sub-routes (bump/archive/unarchive/moderate) can never
  // collide with the length-2 ':id' route (matchRoute requires an equal segment count).
  { segments: ['ads'], handler: adsCreate },
  { segments: ['ads', 'mine'], handler: adsMine },
  { segments: ['ads', ':id'], handler: adItem }, // PATCH edit / DELETE remove
  { segments: ['ads', ':id', 'moderate'], handler: adsModerate },
  { segments: ['ads', ':id', 'bump'], handler: adBump },
  { segments: ['ads', ':id', 'archive'], handler: adArchive },
  { segments: ['ads', ':id', 'unarchive'], handler: adUnarchive },
  { segments: ['cooperation'], handler: cooperationPost },
  // Privacy Policy execution tools (admin: Bearer CRON_SECRET or an admin's initData).
  // erase-user: «выполняем просьбу об удалении в течение 3 рабочих дней» — runs the SAME erasure
  // as the 12-month sweep on one named account. Body { telegram_id } ONLY — the id Telegram itself
  // put in the forwarded «Написали в бот» DM; { dry_run: true } only looks. A public_id (referral
  // code) is refused: its owner publishes it, so it proves nothing about who is asking.
  { segments: ['admin', 'erase-user'], handler: adminEraseUser },
  // takedown-contact: «уберём контакт из приложения» for a THIRD PARTY who has no account —
  // body { contact } (phone/@handle) and/or { vacancy } (uuid / 32-hex / share link). Takes down
  // every card + user ad carrying that contact and records the block so a repost cannot return it.
  { segments: ['admin', 'takedown-contact'], handler: contactTakedown },
  // Referral / loyalty (Authorization: tma <initData>)
  { segments: ['referral'], handler: referralGet },
  // "Красивая ссылка" share: mint a Telegram prepared inline message (branded photo card) for a
  // vacancy so the Mini App can pop it via the native share dialog. tma auth; body { vacancyId }.
  { segments: ['share', 'prepare'], handler: sharePrepare },
  // Listing image (draft_0030). PUBLIC BY NECESSITY: the mini app renders it with a plain
  // <img src="/api/media/<uuid>">, and an <img> sends no Authorization header — an authenticated
  // route could not be used at all. Two things carry the security instead: the id is an
  // unguessable uuid handed out only inside an authenticated feed/detail response, and the handler
  // RE-CHECKS VISIBILITY on every request (bytes come back only while an approved, unexpired card
  // carries them). Everything else is a 404. It never redirects to api.telegram.org (that URL
  // contains the bot token) — the bytes live in our own database.
  { segments: ['media', ':id'], handler: mediaGet },
  // Telegram bot webhook (X-Telegram-Bot-Api-Secret-Token)
  { segments: ['bot', 'webhook'], handler: botWebhook },
  // Cron (bearer CRON_SECRET)
  { segments: ['cron', 'notify'], handler: cronNotify },
  { segments: ['cron', 'digest'], handler: cronDigest },
  { segments: ['cron', 'cleanup'], handler: cronCleanup },
  { segments: ['cron', 'referral-confirm'], handler: cronReferralConfirm },
  // Inactivity erasure (the Privacy Policy's "12 months without a login" promise). Runs as the
  // tail step of cron/cleanup too, so this route is for a controlled/manual run; it is a no-op
  // while config inactive_delete_enabled is false (the shipped default).
  { segments: ['cron', 'inactive-erase'], handler: cronInactiveErase },
  // Owner tool «отложенные публикации»: publish whatever /post scheduled and is now due. Also runs
  // as the tail step of cron/cleanup, so this route is for its own (finer) schedule or a manual run;
  // both are safe together — a run is claimed on (schedule_id, run_no) before anything is published.
  { segments: ['cron', 'scheduled'], handler: cronScheduled },
];

function splitPath(pathname: string): string[] {
  return pathname.split('/').filter((s) => s.length > 0);
}

function matchRoute(route: Route, parts: string[]): { id: string | null } | false {
  if (route.segments.length !== parts.length) return false;
  let id: string | null = null;
  for (let i = 0; i < route.segments.length; i++) {
    const tpl = route.segments[i]!;
    const got = parts[i]!;
    if (tpl === ':id') {
      id = decodeURIComponent(got);
      continue;
    }
    if (tpl !== got) return false;
  }
  return { id };
}

export default async function router(req: ReqLike, res: ResLike): Promise<void> {
  // The rewrite delivers the logical route in req.query.path (segments joined by '/');
  // the rest of req.query is the real query (cities, work_types, cursor, ...). Fall back
  // to req.url for a direct/local call made without the rewrite.
  const query: Record<string, string | string[] | undefined> = { ...(req.query ?? {}) };
  const rawPath = query.path;
  const pathStr = Array.isArray(rawPath) ? rawPath.join('/') : (rawPath ?? '');
  delete query.path; // internal routing param — never forwarded to handlers

  let parts: string[];
  if (pathStr) {
    parts = splitPath(pathStr);
  } else {
    let pathname = '/';
    try {
      const u = new URL(req.url ?? '/', 'http://internal');
      pathname = u.pathname;
      // If the platform did not pre-parse the query into req.query, take it from the URL.
      if (Object.keys(query).length === 0) {
        for (const [k, v] of u.searchParams.entries()) {
          const existing = query[k];
          if (existing === undefined) query[k] = v;
          else if (Array.isArray(existing)) existing.push(v);
          else query[k] = [existing, v];
        }
      }
    } catch {
      return send(res, httpStatusFor(ApiErrorCode.NotFound), makeError(ApiErrorCode.NotFound, `bad url`));
    }
    parts = splitPath(pathname);
    if (parts[0] === 'api') parts = parts.slice(1);
  }

  for (const route of ROUTES) {
    const m = matchRoute(route, parts);
    if (m === false) continue;
    if (m.id !== null) query.id = m.id;
    req.query = query;
    try {
      return await route.handler(req, res);
    } catch (err) {
      // Last-resort catch for errors that ESCAPE a handler's own try/catch — i.e. throws
      // BEFORE the handler's internal guard (e.g. authenticate() on missing BOT_TOKEN, a
      // routing/parse throw). Most handlers already swallow their own DB faults with a local
      // `catch { sendError(Internal) }` (no cause), so those are NOT covered here yet — a
      // follow-up sweep will thread the cause through those ~47 sites for full coverage.
      // What IS caught here: cause (message + stack) is logged centrally under the SAME
      // errorId returned to the caller, so this class of live 500 is diagnosable; no request
      // body/PII is logged (see sendError).
      return sendError(res, ApiErrorCode.Internal, 'handler_error', err);
    }
  }

  return send(res, httpStatusFor(ApiErrorCode.NotFound), makeError(ApiErrorCode.NotFound, `no route /${parts.join('/')}`));
}
