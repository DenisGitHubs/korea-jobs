-- draft_0009_raw_text_hash.sql
-- korea-jobs — PRE-AI exact-duplicate dedup. The same posting is often reposted BYTE-FOR-BYTE
-- across several channels (e.g. @odinvkoree and @Korea_Vakansii). We collapse those copies
-- BEFORE the parser calls the model, so no tokens are spent parsing the same text twice.
--
-- text_hash = sha256-hex of the NORMALIZED message text. Normalization + hashing live in JS
-- (lib/korea/parser/texthash.ts), NOT in SQL, so the value always matches what the running
-- parser writes; the backfill (db/backfill_raw_text_hash.mts) uses the same function. NULL for
-- very short texts (< ~40 chars normalized) and for the reader's fresh inserts until the parser
-- fills it lazily. reject_reason is free TEXT (draft_0003_moderation.sql), so the pipeline's
-- 'duplicate' code needs NO enum change here.
--
-- ADDITIVE ONLY. Guarded (IF NOT EXISTS). DRAFT — DO NOT APPLY; the internal side applies it.
-- Depends on: raw_messages (draft_0001_init.sql).

alter table raw_messages
  add column if not exists text_hash text;

comment on column raw_messages.text_hash is
  'sha256-hex of the JS-normalized message text (lib/korea/parser/texthash.ts); NULL for very short texts. Drives exact-duplicate dedup BEFORE the AI parse.';

-- Cross-source exact-duplicate lookup (parser cross-time check + audits). Partial so it stays
-- lean — the null rows (short/unhashed) never need to be found by hash. Non-unique on purpose:
-- many raws legitimately share a hash (that IS the duplicate set); a unique index would break
-- inserts of the second+ copy.
create index if not exists idx_raw_text_hash
  on raw_messages (text_hash)
  where text_hash is not null;
