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
//   /api/cities|vacancies|me|subscription|terms|ads|cooperation -> tma <initData>
//   /api/vacancies/:id/takedown, /api/ads/:id/moderate-> admin (CRON_SECRET | ADMIN_TELEGRAM_IDS)
//   /api/bot/webhook                                  -> X-Telegram-Bot-Api-Secret-Token
//   /api/cron/parse|notify|cleanup                    -> Bearer CRON_SECRET

import { type ReqLike, type ResLike, send } from '../lib/korea/core/http.js';
import { ApiErrorCode, httpStatusFor, makeError } from '../lib/korea/core/errors.js';
import { sourcesGet, ingestPost } from '../lib/korea/ingest/handler.js';
import { cronParse, cronNotify, cronCleanup } from '../lib/korea/cron/handler.js';
import { botWebhook } from '../lib/korea/bot/webhook.js';
import { citiesGet } from '../lib/korea/cities/read.js';
import { vacanciesFeed, vacancyDetail, vacancyContact } from '../lib/korea/vacancies/read.js';
import { vacancyReport } from '../lib/korea/reports/rw.js';
import { vacancyTakedown } from '../lib/korea/vacancies/moderate.js';
import { meGet } from '../lib/korea/users/me.js';
import { subscriptionPost } from '../lib/korea/subscriptions/rw.js';
import { termsAccept } from '../lib/korea/terms/rw.js';
import { adsCreate, adsMine, adsModerate } from '../lib/korea/ads/rw.js';
import { cooperationPost } from '../lib/korea/cooperation/rw.js';

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
  { segments: ['vacancies'], handler: vacanciesFeed },
  { segments: ['vacancies', ':id'], handler: vacancyDetail },
  { segments: ['vacancies', ':id', 'contact'], handler: vacancyContact },
  { segments: ['vacancies', ':id', 'report'], handler: vacancyReport },
  // Admin (bearer CRON_SECRET or ADMIN_TELEGRAM_IDS user)
  { segments: ['vacancies', ':id', 'takedown'], handler: vacancyTakedown },
  { segments: ['me'], handler: meGet },
  { segments: ['subscription'], handler: subscriptionPost },
  { segments: ['terms', 'accept'], handler: termsAccept },
  // User ads ("Разместить")
  { segments: ['ads'], handler: adsCreate },
  { segments: ['ads', 'mine'], handler: adsMine },
  { segments: ['ads', ':id', 'moderate'], handler: adsModerate },
  { segments: ['cooperation'], handler: cooperationPost },
  // Telegram bot webhook (X-Telegram-Bot-Api-Secret-Token)
  { segments: ['bot', 'webhook'], handler: botWebhook },
  // Cron (bearer CRON_SECRET)
  { segments: ['cron', 'notify'], handler: cronNotify },
  { segments: ['cron', 'cleanup'], handler: cronCleanup },
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
    } catch {
      // Any unhandled handler error (auth throwing on missing BOT_TOKEN, a DB fault,
      // ...) -> uniform 500 envelope instead of a raw crash.
      return send(res, httpStatusFor(ApiErrorCode.Internal), makeError(ApiErrorCode.Internal, 'handler_error'));
    }
  }

  return send(res, httpStatusFor(ApiErrorCode.NotFound), makeError(ApiErrorCode.NotFound, `no route /${parts.join('/')}`));
}
