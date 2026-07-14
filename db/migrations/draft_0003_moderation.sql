-- draft_0003_moderation.sql
-- korea-jobs — Phase 1 v2: persist the parser's moderation verdict on raw_messages so
-- skipped rows carry a WHY (tunable + auditable). ADDITIVE ONLY.
--
--   reject_reason : free text (the model's enum reason, or a code the pipeline sets
--                   such as 'takedown'). Kept as text on purpose — flexible, no DB enum.
--   confidence    : 0..1 the model gave for "is this a genuine vacancy".

alter table raw_messages
  add column if not exists reject_reason text,
  add column if not exists confidence    real;

comment on column raw_messages.reject_reason is 'Why this message was skipped (model reason enum or pipeline code e.g. takedown).';
comment on column raw_messages.confidence    is 'Parser confidence 0..1 that the message is a genuine vacancy.';
