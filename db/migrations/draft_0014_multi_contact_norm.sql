-- draft_0014_multi_contact_norm.sql
-- korea-jobs — CRIT fix: dedup + has_contact must key on the FIRST contact only.
--
-- Since 2026-07-19 a vacancy's contact_raw may carry SEVERAL contacts joined by " · "
-- (a space, a middle-dot U+00B7, a space) — the AI parser (lib/korea/parser/prompt.ts) and
-- the mini-app ad form (lib/korea/ads/input.ts) both emit that shape. The old
-- kj_normalize_contact treated the WHOLE string as ONE phone, which breaks two things:
--   (a) a multi-contact list has >13 digits -> kj_normalize_phone returns NULL ->
--       contact_normalized is NULL -> has_contact=false -> the "Показать контакт" button
--       disappears for a vacancy that actually HAS contacts;
--   (b) content_hash's contact segment collapses to 'nocontact', so DIFFERENT vacancies
--       (different first phones) glue onto ONE dedup key and shadow each other.
--
-- Fix: key on the FIRST segment only — kj_normalize_contact now runs
-- split_part(raw, ' · ', 1) BEFORE the existing normalization. This ONE function change is
-- enough because kj_content_hash() AND both generated columns
-- (vacancies.contact_normalized, vacancies.content_hash) all call kj_normalize_contact:
--   * contact_normalized  = kj_normalize_contact(contact_raw)                  (0001)
--   * content_hash        = ... kj_normalize_contact(contact_raw) ...          (0001)
--   * kj_content_hash()   = ... kj_normalize_contact(p_contact_raw) ...        (0003)
-- so has_contact, the STORED dedup hash and the parser's PROSPECTIVE hash (the CTE in
-- parser/run.ts calls kj_content_hash) all move in lockstep and can never drift.
--
-- split_part is IMMUTABLE, so the function stays IMMUTABLE and can keep driving the two
-- generated columns (a non-immutable body would be rejected there).
--
-- BYTE-FOR-BYTE COMPAT for single values: when contact_raw has NO " · " separator,
-- split_part(raw, ' · ', 1) returns the WHOLE string, so the normalized result is identical
-- to the old function. Existing STORED generated values therefore stay correct and need NO
-- recompute — and no multi-contact rows exist yet anyway (the multi-contact feature is not
-- live). Only FUTURE multi-contact rows change behavior (they key on the first contact).
--
-- ADDITIVE / idempotent (CREATE OR REPLACE). DRAFT ONLY — do NOT apply automatically
-- (rule #4). Apply order (Neon): ... -> 0013 -> 0014. See db/apply.mjs `files`.

create or replace function kj_normalize_contact(raw text)
returns text
language sql
immutable
as $$
  with seg as (
    -- FIRST contact only. The multi-contact separator is " · " = a space, a middle-dot
    -- (U+00B7), a space — identical to the string the parser/ad-form join with. A single
    -- value has no separator, so split_part returns the whole string unchanged and the
    -- result below is byte-for-byte the same as the pre-0014 function.
    select split_part(raw, ' · ', 1) as v
  )
  select case
    when v is null or btrim(v) = '' then null
    when length(regexp_replace(v, '[^0-9]', '', 'g')) >= 9
      then kj_normalize_phone(v)
    else nullif(lower(btrim(regexp_replace(replace(v, '@', ''), '\s+', '', 'g'))), '')
  end
  from seg;
$$;

comment on function kj_normalize_contact(text) is
  'FIRST contact only (split_part on " · ") -> normalized phone; else lowercased handle/id; NULL when empty. Single value (no separator) keeps pre-0014 semantics. Drives contact_normalized + content_hash + kj_content_hash — keep them in sync via THIS function.';
