// lib/korea/core/http.ts
//
// Minimal request/response surface shared by the catch-all router and the thin
// handlers, plus body/header/auth helpers. Mirrors the cargobob _util pattern so a
// handler can run both under Vercel and under the router with no changes.

import { timingSafeEqual } from 'node:crypto';
import { ApiErrorCode, httpStatusFor, makeError } from './errors.js';

export interface ResLike {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body: string): void;
}

export interface ReqLike {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
  on?: (event: string, cb: (chunk?: unknown) => void) => void;
}

/** Read one header as a single string (collapses an accidental string[]). */
export function header(req: ReqLike, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/** Read one query param as a single string (collapses an accidental string[]). */
export function queryParam(req: ReqLike, name: string): string | undefined {
  const v = req.query?.[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Send a JSON response with a status. */
export function send(res: ResLike, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

/** Send the uniform error envelope for a code. Logs id + code only (never PII) so a
 *  production failure is traceable via errorId (errors.ts contract). */
export function sendError(res: ResLike, code: ApiErrorCode, detail?: string): void {
  const body = makeError(code, detail);
  // eslint-disable-next-line no-console
  console.error(`[api] error ${code} ${body.errorId}`);
  send(res, httpStatusFor(code), body);
}

/**
 * Read and JSON-parse the request body. Handles an already-parsed object (Vercel),
 * a raw string, or a Node stream. Returns null when there is no body / bad JSON.
 */
export async function readJsonBody(req: ReqLike): Promise<unknown> {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string') {
      try {
        return JSON.parse(req.body);
      } catch {
        return null;
      }
    }
  }
  if (typeof req.on !== 'function') return null;
  const raw = await new Promise<string>((resolve) => {
    let data = '';
    req.on!('data', (chunk?: unknown) => {
      data += String(chunk);
    });
    req.on!('end', () => resolve(data));
    req.on!('error', () => resolve(''));
  });
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Parse a bearer token from the Authorization header ("Bearer <x>"). */
export function bearerToken(req: ReqLike): string | undefined {
  const auth = header(req, 'authorization');
  if (!auth) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1] : undefined;
}

/** Parse the raw initData from the Authorization header ("tma <initData>"). */
export function tmaInitData(req: ReqLike): string | undefined {
  const auth = header(req, 'authorization');
  if (!auth) return undefined;
  const m = /^tma\s+(.+)$/i.exec(auth);
  return m ? m[1] : undefined;
}

/** Constant-time string comparison (false on any length/None mismatch). */
export function constantTimeEquals(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
