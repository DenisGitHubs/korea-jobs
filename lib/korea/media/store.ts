// lib/korea/media/store.ts
//
// Storing an image the owner attached to a scheduled post (draft_0030 → media_files).
//
// WHY WE COPY THE BYTES INSTEAD OF KEEPING A TELEGRAM REFERENCE
// A Telegram file_id is not a URL: turning it into one needs the bot token, and the resulting
// https://api.telegram.org/file/bot<TOKEN>/… link would hand that token to every browser that
// renders the card. A file_path also expires after about an hour. So the picture is downloaded
// ONCE, at scheduling time, and afterwards served from our own origin (GET /api/media/:id).
//
// WHICH SIZE WE TAKE: message.photo[] is the SAME picture in several sizes, already re-encoded
// by Telegram; the LAST/largest element is the best one available and is comfortably small
// (typically far below the configured ceiling). We deliberately do NOT accept `document` uploads
// ("send as file"): those are arbitrary, un-recompressed blobs of any size and type.
//
// DEDUP: sha256 is the unique key, so re-sending the same picture reuses the stored row.
//
// TRANSPORT NOTE (Neon HTTP driver): parameters are JSON-encoded, so a Buffer cannot be bound as
// bytea directly. The bytes travel as a hex string and are converted in SQL — decode($n, 'hex')
// on the way in, encode(bytes, 'hex') on the way out. That is also why the size ceiling matters:
// the hex form is twice the size of the image inside the statement.

import { createHash } from 'node:crypto';
import { getSql } from '../core/db.js';
import { getConfigNumber } from '../config.js';
import { getFile, downloadFile, maskToken } from '../bot/telegram.js';

type Sql = ReturnType<typeof getSql>;

/** Default ceiling on a stored image (config: scheduled_media_max_bytes). */
export const MEDIA_MAX_BYTES_DEFAULT = 2_000_000;

/**
 * Absolute ceiling the config CANNOT raise. The setting exists to lower the
 * limit, not to lift it: a typo (200000000 instead of 2000000) would otherwise
 * pull 200 MB into the function's memory and ~400 MB of hex into a single SQL
 * statement — the function dies instead of refusing the file politely.
 */
export const MEDIA_MAX_BYTES_HARD = 5_000_000;

/** Image types we accept and are willing to serve back. */
export const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** One element of Telegram's message.photo[] (the fields we use). */
export interface TgPhotoSize {
  file_id?: unknown;
  file_size?: unknown;
  width?: unknown;
  height?: unknown;
}

export interface PickedPhoto {
  fileId: string;
  width: number | null;
  height: number | null;
}

/**
 * The LARGEST element of message.photo[] — Telegram sorts them small→large, but we compare by
 * pixel area (falling back to file_size) instead of trusting the order. Returns null when the
 * update carries no usable photo.
 */
export function pickLargestPhoto(photos: unknown): PickedPhoto | null {
  if (!Array.isArray(photos)) return null;
  let best: PickedPhoto | null = null;
  let bestScore = -1;
  for (const raw of photos) {
    const p = raw as TgPhotoSize;
    if (!p || typeof p.file_id !== 'string' || p.file_id.length === 0) continue;
    const w = typeof p.width === 'number' ? p.width : null;
    const h = typeof p.height === 'number' ? p.height : null;
    const size = typeof p.file_size === 'number' ? p.file_size : 0;
    const score = w && h ? w * h : size;
    if (score > bestScore) {
      bestScore = score;
      best = { fileId: p.file_id, width: w, height: h };
    }
  }
  return best;
}

/** Map a Telegram file_path / content-type to a whitelisted mime, or null when unsupported. */
export function mimeFor(filePath: string, contentType: string | null): string | null {
  const ct = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (ALLOWED_MIME.has(ct)) return ct;
  const ext = (/\.([a-z0-9]+)$/i.exec(filePath)?.[1] ?? '').toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  return null;
}

export interface StoredMedia {
  id: string;
  mime: string;
  sizeBytes: number;
}

/** Injectable Telegram side so the store can be unit-tested without the Bot API. */
export interface MediaDeps {
  getFile: typeof getFile;
  downloadFile: typeof downloadFile;
}

const REAL_DEPS: MediaDeps = { getFile, downloadFile };

/**
 * Download one Telegram photo and store it. Returns the stored row (id + mime + size), or null
 * when Telegram refused, the file is too big, or the type is not an image we serve. NEVER throws
 * and never logs the file URL (see telegram.downloadFile).
 */
export async function storeTelegramPhoto(
  sql: Sql,
  photo: PickedPhoto,
  uploadedBy: string | null,
  deps: MediaDeps = REAL_DEPS,
): Promise<StoredMedia | null> {
  // Clamped, not trusted: the config may only lower the ceiling (see MEDIA_MAX_BYTES_HARD).
  const configured = await getConfigNumber('scheduled_media_max_bytes', MEDIA_MAX_BYTES_DEFAULT);
  const maxBytes = Math.min(Math.max(1, configured), MEDIA_MAX_BYTES_HARD);
  try {
    const meta = await deps.getFile(photo.fileId);
    const filePath = meta.ok ? meta.result?.file_path : undefined;
    if (!filePath) {
      // eslint-disable-next-line no-console
      console.error('[media] getFile gave no file_path');
      return null;
    }
    const { bytes, contentType } = await deps.downloadFile(filePath, maxBytes);
    const mime = mimeFor(filePath, contentType);
    if (!mime) {
      // eslint-disable-next-line no-console
      console.error('[media] unsupported image type');
      return null;
    }
    const buf = Buffer.from(bytes);
    const sha = createHash('sha256').update(buf).digest('hex');
    const hex = buf.toString('hex');
    // Dedup on sha256; the DO UPDATE refreshes the traceable file_id and gives us `id` in both
    // the insert and the conflict branch (a bare DO NOTHING would return no row on a repeat).
    const rows = (await sql`
      insert into media_files (sha256, mime, bytes, width, height, size_bytes, tg_file_id, uploaded_by)
      values (${sha}, ${mime}, decode(${hex}, 'hex'), ${photo.width}, ${photo.height},
              ${buf.byteLength}, ${photo.fileId}, ${uploadedBy}::uuid)
      on conflict (sha256) do update set tg_file_id = excluded.tg_file_id
      returning id`) as unknown as { id: string }[];
    const id = rows[0]?.id;
    if (!id) return null;
    return { id: String(id), mime, sizeBytes: buf.byteLength };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[media] store failed:', maskToken(String(err)));
    return null;
  }
}
