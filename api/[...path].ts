// api/[...path].ts
//
// Catch-all serverless entry: ONE Vercel function for the whole API, so the Hobby
// 12-function ceiling is respected. The filename is a Vercel catch-all dynamic route
// ([...path]), so EVERY /api/<anything> request is filesystem-routed here with the
// ORIGINAL req.url preserved (no rewrite needed) — the router below reads req.url and
// strips the leading 'api' segment. Routes are matched by path segments; each thin
// handler owns its own method-routing, auth and status codes.
//
// app/ and api/ deploy as ONE Vercel project (same-origin), so no CORS is needed for
// the Mini App endpoints. The ingest/sources endpoints are server-to-server.
//
// Auth per route group (see architecture.md):
//   /api/ingest, /api/sources        -> Bearer INGEST_SECRET
//   /api/cities|vacancies|me|subscription -> Authorization: tma <initData>
//   /api/bot/webhook                 -> X-Telegram-Bot-Api-Secret-Token
//   /api/cron/parse|notify|cleanup   -> Bearer CRON_SECRET

import { type ReqLike, type ResLike, send } from '../lib/korea/core/http.js';
import { ApiErrorCode, httpStatusFor, makeError } from '../lib/korea/core/errors.js';
import { sourcesGet, ingestPost } from '../lib/korea/ingest/handler.js';
import { cronParse, cronNotify, cronCleanup } from '../lib/korea/cron/handler.js';
import { botWebhook } from '../lib/korea/bot/webhook.js';
import { citiesGet } from '../lib/korea/cities/read.js';
import { vacanciesFeed, vacancyDetail, vacancyContact } from '../lib/korea/vacancies/read.js';
import { meGet } from '../lib/korea/users/me.js';
import { subscriptionPost } from '../lib/korea/subscriptions/rw.js';

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
  { segments: ['me'], handler: meGet },
  { segments: ['subscription'], handler: subscriptionPost },
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
  const rawUrl = req.url ?? '/';
  let pathname: string;
  let search: URLSearchParams;
  try {
    const u = new URL(rawUrl, 'http://internal');
    pathname = u.pathname;
    search = u.searchParams;
  } catch {
    return send(res, httpStatusFor(ApiErrorCode.NotFound), makeError(ApiErrorCode.NotFound, `bad url`));
  }

  // Vercel filesystem catch-all routing delivers the original path (/api/<...>), so we
  // strip the leading 'api' segment to get the logical route. Kept tolerant of a path
  // arriving without /api (e.g. a local/dev invocation).
  let parts = splitPath(pathname);
  if (parts[0] === 'api') parts = parts.slice(1);

  // Mirror Vercel's req.query (single-value map, arrays for repeats).
  const query: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of search.entries()) {
    const existing = query[k];
    if (existing === undefined) query[k] = v;
    else if (Array.isArray(existing)) existing.push(v);
    else query[k] = [existing, v];
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

  return send(res, httpStatusFor(ApiErrorCode.NotFound), makeError(ApiErrorCode.NotFound, `no route ${pathname}`));
}
