// lib/korea/core/errors.ts
//
// Uniform error envelope for the API: { error, errorId, detail? }. errorId is a
// random id the client can quote in a report; server logs the same id. Never put a
// secret or PII in `detail`.

import { randomUUID } from 'node:crypto';

export const ApiErrorCode = {
  BadRequest: 'bad_request',
  Unauthorized: 'unauthorized',
  NotFound: 'not_found',
  RateLimited: 'rate_limited',
  Internal: 'internal',
} as const;

export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];

export interface ApiErrorBody {
  error: ApiErrorCode;
  errorId: string;
  detail?: string;
}

export function httpStatusFor(code: ApiErrorCode): number {
  switch (code) {
    case ApiErrorCode.BadRequest:
      return 400;
    case ApiErrorCode.Unauthorized:
      return 401;
    case ApiErrorCode.NotFound:
      return 404;
    case ApiErrorCode.RateLimited:
      return 429;
    case ApiErrorCode.Internal:
    default:
      return 500;
  }
}

export function makeError(code: ApiErrorCode, detail?: string): ApiErrorBody {
  return { error: code, errorId: randomUUID(), ...(detail ? { detail } : {}) };
}
