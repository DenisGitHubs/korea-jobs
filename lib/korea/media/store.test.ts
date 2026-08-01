// lib/korea/media/store.test.ts
//
// Storing the photo the owner attached to a /post. The Telegram side is injected, so this covers
// the decisions without touching the network:
//   * we take the LARGEST size of message.photo[] (Telegram sends the same picture several times);
//   * only real images are stored, and only up to the configured ceiling;
//   * a Telegram failure NEVER throws out of here — the post is still worth scheduling;
//   * the bytes travel as hex (the Neon HTTP driver cannot bind a Buffer as bytea) and are deduped
//     on sha256, so re-sending the same picture reuses the stored row.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const state = { max: 2_000_000, queries: [] as string[], values: [] as unknown[][] };
  const fakeSql = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    state.queries.push(strings.join(' ? ').replace(/\s+/g, ' ').trim());
    state.values.push(values);
    return Promise.resolve([{ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }]);
  };
  return { state, fakeSql };
});

vi.mock('../config.js', () => ({
  getConfigNumber: async (_k: string, _fb: number) => h.state.max,
  getConfigBool: async (_k: string, fb: boolean) => fb,
  getConfigString: async (_k: string, fb: string) => fb,
}));
vi.mock('../bot/telegram.js', () => ({
  getFile: () => Promise.resolve({ ok: false }),
  downloadFile: () => Promise.reject(new Error('unused')),
  maskToken: (s: string) => s,
}));

import { pickLargestPhoto, mimeFor, storeTelegramPhoto, type MediaDeps } from './store.js';

const PHOTO = { fileId: 'file-123', width: 1280, height: 960 };

function deps(over: Partial<MediaDeps> = {}): MediaDeps {
  return {
    getFile: (() => Promise.resolve({ ok: true, result: { file_id: 'file-123', file_path: 'photos/a.jpg' } })) as MediaDeps['getFile'],
    downloadFile: (() => Promise.resolve({ bytes: new Uint8Array([1, 2, 3, 4]), contentType: 'image/jpeg' })) as MediaDeps['downloadFile'],
    ...over,
  };
}

beforeEach(() => {
  h.state.max = 2_000_000;
  h.state.queries = [];
  h.state.values = [];
});

describe('pickLargestPhoto', () => {
  it('takes the biggest size, whatever order Telegram sent them in', () => {
    const picked = pickLargestPhoto([
      { file_id: 'small', width: 90, height: 67 },
      { file_id: 'big', width: 1280, height: 960 },
      { file_id: 'mid', width: 320, height: 240 },
    ]);
    expect(picked).toEqual({ fileId: 'big', width: 1280, height: 960 });
  });

  it('falls back to file_size when the sizes carry no dimensions', () => {
    const picked = pickLargestPhoto([
      { file_id: 'a', file_size: 100 },
      { file_id: 'b', file_size: 900 },
    ]);
    expect(picked?.fileId).toBe('b');
  });

  it('null for anything that is not a usable photo array', () => {
    expect(pickLargestPhoto(undefined)).toBeNull();
    expect(pickLargestPhoto([])).toBeNull();
    expect(pickLargestPhoto('photo')).toBeNull();
    expect(pickLargestPhoto([{ width: 10, height: 10 }])).toBeNull(); // no file_id
  });
});

describe('mimeFor', () => {
  it('accepts the three image types we serve', () => {
    expect(mimeFor('photos/a.jpg', 'image/jpeg')).toBe('image/jpeg');
    expect(mimeFor('photos/a.png', null)).toBe('image/png');
    expect(mimeFor('photos/a.webp', 'application/octet-stream')).toBe('image/webp');
    expect(mimeFor('photos/a.JPG', null)).toBe('image/jpeg');
  });

  it('refuses everything else (an html/svg blob must never become servable content)', () => {
    expect(mimeFor('documents/a.svg', 'image/svg+xml')).toBeNull();
    expect(mimeFor('documents/a.pdf', 'application/pdf')).toBeNull();
    expect(mimeFor('documents/a', null)).toBeNull();
  });
});

describe('storeTelegramPhoto', () => {
  it('stores the bytes as hex and returns the row id', async () => {
    const stored = await storeTelegramPhoto(h.fakeSql as never, PHOTO, 'user-1', deps());

    expect(stored).toEqual({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', mime: 'image/jpeg', sizeBytes: 4 });
    const q = h.state.queries[0]!;
    expect(q).toContain('insert into media_files');
    // hex on the way in (the driver JSON-encodes parameters — a Buffer cannot be bound as bytea)…
    expect(q).toContain("decode(");
    expect(q).toContain("'hex')");
    // …and deduped on the content hash, so the same picture is stored once.
    expect(q).toContain('on conflict (sha256)');
    expect(h.state.values[0]).toContain('01020304');
  });

  it('returns null (never throws) when Telegram gives no file_path', async () => {
    const stored = await storeTelegramPhoto(
      h.fakeSql as never,
      PHOTO,
      null,
      deps({ getFile: (() => Promise.resolve({ ok: false })) as MediaDeps['getFile'] }),
    );
    expect(stored).toBeNull();
    expect(h.state.queries).toHaveLength(0);
  });

  it('returns null (never throws) when the download fails or the file is too big', async () => {
    const stored = await storeTelegramPhoto(
      h.fakeSql as never,
      PHOTO,
      null,
      deps({ downloadFile: (() => Promise.reject(new Error('file too large (9000000 bytes)'))) as MediaDeps['downloadFile'] }),
    );
    expect(stored).toBeNull();
    expect(h.state.queries).toHaveLength(0);
  });

  it('refuses a non-image even when Telegram happily returned it', async () => {
    const stored = await storeTelegramPhoto(
      h.fakeSql as never,
      PHOTO,
      null,
      deps({
        getFile: (() => Promise.resolve({ ok: true, result: { file_id: 'x', file_path: 'documents/a.pdf' } })) as MediaDeps['getFile'],
        downloadFile: (() => Promise.resolve({ bytes: new Uint8Array([1]), contentType: 'application/pdf' })) as MediaDeps['downloadFile'],
      }),
    );
    expect(stored).toBeNull();
    expect(h.state.queries).toHaveLength(0);
  });

  it('passes the configured ceiling down to the download', async () => {
    h.state.max = 1024;
    let seen = 0;
    await storeTelegramPhoto(
      h.fakeSql as never,
      PHOTO,
      null,
      deps({
        downloadFile: ((_p: string, max: number) => {
          seen = max;
          return Promise.resolve({ bytes: new Uint8Array([1]), contentType: 'image/png' });
        }) as MediaDeps['downloadFile'],
      }),
    );
    expect(seen).toBe(1024);
  });
});
