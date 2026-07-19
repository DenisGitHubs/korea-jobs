-- draft_0013_reveal_fk.sql
-- korea-jobs — decouple the raw-reveal AUDIT from the LIFE of the raw message.
--
-- WHY (007 major, 2026-07-19). draft_0008 wired raw_contact_reveals.raw_id with ON DELETE
-- CASCADE. Now that the 24h raw purge is live (lib/korea/cleanup/run.ts step 5), deleting an
-- aged raw_message CASCADE-deletes its reveal audit rows. That (a) erases the audit trail and
-- (b) makes reveals24h() UNDER-count raw reveals against the SHARED daily cap — a harvester
-- could shrink its own daily count by simply waiting for the raw to age out, then reveal again.
-- Fix: keep the audit row alive when the raw dies (ON DELETE SET NULL).
--
-- WHY THE CAP SURVIVES: reveals24h() (lib/korea/vacancies/read.ts) counts by
-- (user_id, revealed_at) only — raw_id is NOT part of the sum. The cap is computed entirely
-- from the surviving audit rows, so nulling raw_id leaves it exact.
--
-- WHY THE PK BECOMES A UNIQUE CONSTRAINT: a PRIMARY KEY column cannot be nullable, so raw_id
-- must leave the PK before it can be SET NULL. We swap the composite PK (user_id, raw_id) for a
-- UNIQUE constraint on the SAME columns:
--   * reveal.ts `on conflict (user_id, raw_id) do nothing` still infers this constraint;
--   * a UNIQUE constraint allows repeated NULLs (NULL <> NULL), so many SET-NULL'd audit rows
--     coexist harmlessly. A purged raw can never be revealed again — reveal.ts only matches LIVE
--     raw_messages (see its select) — so a null-raw row is a pure, immutable audit record: never
--     re-counted, never re-inserted. Live inserts always carry a concrete raw_id, so the UNIQUE
--     constraint still blocks a genuine duplicate (user, raw) pair exactly as the PK did.
--
-- ADDITIVE / idempotent — every step is guarded and re-runnable. DRAFT — DO NOT APPLY here; the
-- internal side applies it. Depends on: raw_contact_reveals (draft_0008_raw_reveal.sql).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) Drop the composite PK so raw_id can become nullable, and add the equivalent UNIQUE
--    constraint on the same columns. Guarded by conname so re-applying is a no-op.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'raw_contact_reveals_pkey') then
    alter table raw_contact_reveals drop constraint raw_contact_reveals_pkey;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'uq_raw_reveal_user_raw') then
    alter table raw_contact_reveals
      add constraint uq_raw_reveal_user_raw unique (user_id, raw_id);
  end if;
end
$$;

-- 2) raw_id must be nullable for ON DELETE SET NULL. Unconditional: DROP NOT NULL on an
--    already-nullable column is a no-op in Postgres, so this is safe to re-apply. (The PK from
--    step 1 is gone by now, so the drop succeeds.)
alter table raw_contact_reveals alter column raw_id drop not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) Swap the raw_id FK from ON DELETE CASCADE (draft_0008 inline column FK, auto-named
--    raw_contact_reveals_raw_id_fkey) to ON DELETE SET NULL. Guarded by conname on both the drop
--    and the add so re-applying is a no-op. The user_id FK (…_user_id_fkey) stays CASCADE —
--    a deleted user has no cap left to enforce.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'raw_contact_reveals_raw_id_fkey') then
    alter table raw_contact_reveals drop constraint raw_contact_reveals_raw_id_fkey;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_raw_reveal_raw') then
    alter table raw_contact_reveals
      add constraint fk_raw_reveal_raw
      foreign key (raw_id) references raw_messages (id) on delete set null;
  end if;
end
$$;

comment on constraint fk_raw_reveal_raw on raw_contact_reveals is
  'ON DELETE SET NULL: a purged raw_message leaves its reveal audit row alive (raw_id nulled) so the shared daily cap (reveals24h, by user_id+revealed_at) never under-counts. See draft_0013.';
