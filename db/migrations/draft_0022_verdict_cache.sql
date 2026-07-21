-- draft_0022_verdict_cache.sql
-- korea-jobs — AI verdict cache (owner rule 2026-07-21). A tiny INTERNAL table that lets the parser
-- REUSE a prior AI reject verdict for an EXACT repeat instead of paying the model again. Half of the
-- residual that survives the free filters is byte-exact repeats of a message the AI already judged a
-- reject — often ONE short spam/chit-chat line posted many times an hour, which the raw_messages.text_hash
-- dedup deliberately ignores (its 40-char floor sends short texts to the model as "unique" so two
-- DIFFERENT short vacancies never collide). This cache uses a SEPARATE, floor-less FUZZY hash
-- (lib/korea/parser/verdict-cache.ts verdictHash: a letter-skeleton — lowercase, letters-only
-- Cyrillic/Latin/Hangul, digits/emoji/punctuation stripped, plus a phone-presence marker so a repost
-- that only ADDS a phone number is a different family) so short and digit/emoji-mimicking repeats
-- collapse here. The two contours never mix (texthash.ts is untouched).
--
-- CONTRACT (lib/korea/parser/run.ts):
--   * text_hash     — sha256-hex of the letter-skeleton (+phone marker), NO length floor.
--   * reject_reason — the cached AI verdict, a genuine NON-vacancy reject only (not_vacancy / chitchat /
--                     resume_seeking_job / agency_promo / course_ad / housing / currency_exchange / spam /
--                     unclear / ad_non_job). NEVER 'low_confidence' (that is the visible "Не проверено"
--                     tab) and NEVER a vacancy (those ride the normal dedup contour). The first copy of
--                     anything the model might keep is always judged fresh.
--   * n             — how many times this verdict has been served (first sighting + every later cache hit).
--   * last_seen     — refreshed on every hit; lib/korea/cleanup/run.ts purges rows older than 7 days by it.
--
-- Best-effort by design: a read/write fault here NEVER breaks a parse (verdict-cache.ts swallows + logs).
-- INTERNAL only — no API/bot surface reads it.
--
-- ADDITIVE ONLY. Guarded (IF NOT EXISTS). DRAFT — DO NOT APPLY; the internal side applies it.
-- Depends on: nothing beyond stock Postgres. Apply order: ... 0021 -> 0022.

create table if not exists ai_verdict_cache (
  text_hash     text primary key,
  reject_reason text not null,
  n             int not null default 1,
  last_seen     timestamptz not null default now()
);

comment on table ai_verdict_cache is
  'INTERNAL AI reject-verdict cache: reuse a prior reject for an EXACT (floor-less-hash) repeat so the model is not paid again. Non-vacancy rejects only (never low_confidence, never a vacancy). Purged > 7 days by cleanup. Additive.';

-- cleanup purges by last_seen, so index it for that delete.
create index if not exists idx_ai_verdict_cache_last_seen on ai_verdict_cache (last_seen);
