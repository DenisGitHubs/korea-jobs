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
  /** The request BODY is too big — NOT "the data is wrong". The difference matters to a client
   *  uploading a batch: 413 means "split it and send both halves", 400 means "do not resend". */
  PayloadTooLarge: 'payload_too_large',
  RateLimited: 'rate_limited',
  /** The SERVER is not set up for this call — NOT "your request is wrong" and NOT "your
   *  credential is bad". Where a missing/unusable setting would otherwise masquerade as a
   *  rejected credential, a 401 sends a person to reinstall the app over OUR typo; 503 says
   *  "not us to fix, come back later" (first user: POST /api/auth/hub with no hub key). */
  ServiceUnavailable: 'service_unavailable',
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
    case ApiErrorCode.PayloadTooLarge:
      return 413;
    case ApiErrorCode.RateLimited:
      return 429;
    case ApiErrorCode.ServiceUnavailable:
      return 503;
    case ApiErrorCode.Internal:
    default:
      return 500;
  }
}

export function makeError(code: ApiErrorCode, detail?: string): ApiErrorBody {
  return { error: code, errorId: randomUUID(), ...(detail ? { detail } : {}) };
}
