// lib/korea/media/read.test.ts
//
// GET /api/media/:id — the ONLY endpoint in the project without authentication, so its guarantees
// are pinned here rather than trusted:
//   * bytes come back ONLY while a VISIBLE card carries the image (approved + not expired). The
//     moment a listing is archived / rejected / taken down / expired, its picture is a 404 — a link
//     that leaked earlier stops working exactly like the card itself;
//   * the visibility predicate really is in the query (the double below refuses to answer if the
//     handler ever stops asking for it — a silent "serve everything" regression cannot pass);
//   * a bad id, an unknown id and a non-GET are indistinguishable 404s;
//   * the content type comes from OUR whitelist, never from the row;
//   * we NEVER redirect to api.telegram.org (that URL contains the bot token).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    /** null = no such media row at all. */
    ad: null as { status: string; expired: boolean } | null,
    mime: 'image/jpeg',
    hex: 'ffd8ffdb00', // a few bytes; the value only has to survive the round trip
    queries: [] as string[],
  };
  const fakeSql = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const q = strings.join(' ? ').replace(/\s+/g, ' ').trim();
    state.queries.push(q);
    void values;
    // The double enforces the SAME predicate the handler is supposed to ask for. If the guard is
    // ever dropped from the SQL, `guarded` goes false and every test that expects bytes fails.
    const guarded =
      q.includes('a.media_id = m.id') &&
      q.includes("a.status = 'approved'") &&
      q.includes('a.expires_at is null or a.expires_at > now()');
    const visible = guarded && state.ad !== null && state.ad.status === 'approved' && !state.ad.expired;
    return Promise.resolve(visible ? [{ mime: state.mime, hex: state.hex }] : []);
  };
  return { state, fakeSql };
});

vi.mock('../core/db.js', () => ({ getSql: () => h.fakeSql }));

import { mediaGet, MEDIA_CACHE_CONTROL } from './read.js';
import type { ReqLike, ResLike } from '../core/http.js';

const ID = '0f8c2a1b-3d4e-4f5a-6b7c-8d9e0f1a2b3c';

interface TestRes extends ResLike {
  _status: number;
  _headers: Record<string, string>;
  _body: string | Uint8Array;
}

function makeRes(): TestRes {
  return {
    _status: 0,
    _headers: {},
    _body: '',
    statusCode: 0,
    setHeader(name: string, value: string) {
      this._headers[name.toLowerCase()] = value;
    },
    end(body: string | Uint8Array) {
      this._status = this.statusCode;
      this._body = body;
    },
  };
}

/** `id: null` means the request carried no id at all (a default parameter cannot express that). */
async function get(id: string | null = ID, method = 'GET'): Promise<TestRes> {
  const req: ReqLike = { method, headers: {}, query: id === null ? {} : { id } };
  const res = makeRes();
  await mediaGet(req, res);
  return res;
}

beforeEach(() => {
  h.state.ad = { status: 'approved', expired: false };
  h.state.mime = 'image/jpeg';
  h.state.hex = 'ffd8ffdb00';
  h.state.queries = [];
});

describe('GET /api/media/:id — a visible card', () => {
  it('serves the bytes with our own content type and an immutable cache', async () => {
    const res = await get();

    expect(res._status).toBe(200);
    expect(res._headers['content-type']).toBe('image/jpeg');
    expect(res._headers['cache-control']).toBe(MEDIA_CACHE_CONTROL);
    expect(res._body).toBeInstanceOf(Buffer);
    expect(Buffer.from(res._body as Uint8Array).toString('hex')).toBe('ffd8ffdb00');
    expect(res._headers['content-length']).toBe('5');
  });

  it('never hands out a Telegram URL and never redirects', async () => {
    const res = await get();
    expect(res._headers['location']).toBeUndefined();
    expect(String(res._body)).not.toContain('api.telegram.org');
    expect(JSON.stringify(res._headers)).not.toContain('api.telegram.org');
  });
});

describe('GET /api/media/:id — an image whose card is no longer visible', () => {
  for (const status of ['archived', 'rejected', 'taken_down', 'pending', 'expired']) {
    it(`404 for a ${status} listing`, async () => {
      h.state.ad = { status, expired: false };
      const res = await get();
      expect(res._status).toBe(404);
      expect(String(res._body)).toContain('not_found');
    });
  }

  it('404 once the listing has expired', async () => {
    h.state.ad = { status: 'approved', expired: true };
    expect((await get())._status).toBe(404);
  });

  it('404 when nothing references the image at all', async () => {
    h.state.ad = null;
    expect((await get())._status).toBe(404);
  });
});

describe('GET /api/media/:id — bad requests', () => {
  it('404 for a non-uuid id (and the database is not even asked)', async () => {
    const res = await get('../../etc/passwd');
    expect(res._status).toBe(404);
    expect(h.state.queries).toHaveLength(0);
  });

  it('404 for a missing id', async () => {
    expect((await get(null))._status).toBe(404);
  });

  it('404 for a non-GET method', async () => {
    expect((await get(ID, 'POST'))._status).toBe(404);
    expect((await get(ID, 'DELETE'))._status).toBe(404);
  });

  it('404 when the stored mime is not one we chose to serve', async () => {
    h.state.mime = 'text/html';
    const res = await get();
    expect(res._status).toBe(404);
  });
});
