// lib/korea/core/http.test.ts
//
// sendError is the single point that shapes the API error envelope AND writes the trace
// line. This suite pins the diagnosability contract added for live 500s:
//   1. every error response carries an `errorId`, and the SAME id appears in the log;
//   2. an UNEXPECTED internal (500) with a `cause` logs the technical reason (message +
//      stack) so a live failure is diagnosable;
//   3. expected/known errors (401/404/429/400) and any call without a cause never log a
//      stack — they must not flood the log;
//   4. the request body / auth / PII is never touched here (the only inputs are code,
//      an optional fixed `detail` tag, and the technical error).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendError, type ResLike } from './http.js';
import { ApiErrorCode } from './errors.js';

function makeRes() {
  const res = {
    statusCode: 0,
    body: '',
    headers: {} as Record<string, string>,
    setHeader(n: string, v: string) {
      this.headers[n] = v;
    },
    end(b: string) {
      this.body = b;
    },
  };
  return res as ResLike & { body: string; headers: Record<string, string> };
}

let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
});

/** All console.error args flattened into one string for easy matching. */
function loggedText(): string {
  return errSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
}

describe('sendError — envelope + trace id', () => {
  it('internal 500 returns a short errorId and logs the SAME id with the reason', () => {
    const res = makeRes();
    const cause = new Error('boom: neon connection refused');

    sendError(res, ApiErrorCode.Internal, 'handler_error', cause);

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body) as { error: string; errorId: string; detail?: string };
    expect(body.error).toBe('internal');
    expect(typeof body.errorId).toBe('string');
    expect(body.errorId.length).toBe(8); // short, quotable
    expect(body.detail).toBe('handler_error');

    const log = loggedText();
    // the id in the body is exactly the id in the log
    expect(log).toContain(body.errorId);
    // the technical reason (message) is logged
    expect(log).toContain('boom: neon connection refused');
    // and the stack, so a live 500 is diagnosable
    expect(log).toContain('stack');
  });

  it('does NOT log the request body / PII — only code, id and the error text', () => {
    const res = makeRes();
    // a cause whose message is a normal technical error; sendError has no access to req
    sendError(res, ApiErrorCode.Internal, 'handler_error', new TypeError('x is not a function'));
    const log = loggedText();
    expect(log).toContain('x is not a function');
    // nothing that could be a request body / header / token is present
    expect(log).not.toMatch(/authorization|initdata|telegram_id|Bearer/i);
  });
});

describe('sendError — expected errors stay quiet (no stack)', () => {
  // 🔴 THE TABLE IS THE WHOLE VOCABULARY MINUS `internal`, and the test right below holds
  // it to that. ServiceUnavailable (503) shipped with the second door on 23.09.2026 and
  // was in neither this table nor sendError's own doc comment — so the newest code in the
  // project was the one code nobody had ever run through here (Censor, fix №11).
  const cases: Array<[ApiErrorCode, number]> = [
    [ApiErrorCode.Unauthorized, 401],
    [ApiErrorCode.NotFound, 404],
    [ApiErrorCode.PayloadTooLarge, 413],
    [ApiErrorCode.RateLimited, 429],
    [ApiErrorCode.BadRequest, 400],
    [ApiErrorCode.ServiceUnavailable, 503],
  ];

  it('🔴 the table covers every ApiErrorCode except `internal` — a new code cannot slip past', () => {
    const covered = [...new Set(cases.map(([code]) => String(code)))].sort();
    const expected = Object.values(ApiErrorCode)
      .filter((c) => c !== ApiErrorCode.Internal)
      .map(String)
      .sort();
    expect(covered).toEqual(expected);
  });

  for (const [code, status] of cases) {
    it(`${code} -> ${status}: envelope has errorId, log carries no stack`, () => {
      const res = makeRes();
      sendError(res, code);

      expect(res.statusCode).toBe(status);
      const body = JSON.parse(res.body) as { error: string; errorId: string };
      expect(body.error).toBe(code);
      expect(body.errorId.length).toBe(8);

      const log = loggedText();
      expect(log).toContain(body.errorId);
      expect(log).toContain(code);
      // the whole point: known errors never dump a stack
      expect(log).not.toContain('stack');
    });
  }

  it('internal WITHOUT a cause also logs no stack (only unexpected throws carry one)', () => {
    const res = makeRes();
    sendError(res, ApiErrorCode.Internal); // e.g. a handler self-reporting a 500 with no err
    expect(res.statusCode).toBe(500);
    const log = loggedText();
    expect(log).not.toContain('stack');
  });
});
