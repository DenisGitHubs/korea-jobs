-- draft_sources_seed_2.sql
-- Owner's second batch of Telegram job chats/channels for Korea (15.07.2026).
-- Provided directly by the owner (no Susanin search needed — owner-approved).
-- tg_chat_id stays NULL — the reader (userbot) resolves + fills it on join.
-- Idempotent: a username is inserted only if not already present (so the two
-- overlaps with draft_sources_seed.sql, e.g. rabota_vsya_korea, are skipped).
--
-- DRAFT ONLY. Apply after draft_0001_init.sql (creates `sources`).
--
-- NOTE: two links look like RANDOM invite hashes, not human usernames
-- ('ZkrsrTREssoyMjIy', 'LGBH6UeZdJkOWU1'). If those are PRIVATE channels reached
-- by an invite link (t.me/+<hash> / joinchat), a bare username will NOT resolve
-- and the reader can't join — flagged in `notes` for the owner to confirm.

insert into sources (username, title, type, is_active, added_by, notes)
select v.username, v.title, v.type::source_type, true, 'owner', v.notes
from (values
  ('GoodpeopleGwangju',  'Good People Gwangju',        'unknown', 'batch2 15.07; Gwangju'),
  ('jobinkoreaforus',    'Job in Korea for us',        'unknown', 'batch2 15.07'),
  ('akkorea',            'AK Korea',                   'unknown', 'batch2 15.07'),
  ('rabotavkoreya',      'Работа в Корее',             'unknown', 'batch2 15.07'),
  ('ZkrsrTREssoyMjIy',   'источник (проверить ссылку)','unknown', 'batch2 15.07; CHECK: looks like a private invite hash, not a username'),
  ('umkaworkkorea',      'Umka Work Korea',            'unknown', 'batch2 15.07'),
  ('rabota_vsya_korea',  'Работа вся Корея',           'unknown', 'batch2 15.07 (already seeded)'),
  ('workansan',          'Work Ansan (Ансан)',         'unknown', 'batch2 15.07; Ansan'),
  ('WorkWorld_Group',    'Work World Group',           'unknown', 'batch2 15.07'),
  ('jobdv',              'Job DV',                     'unknown', 'batch2 15.07'),
  ('Korea_Arbayt',       'Korea Arbayt',               'unknown', 'batch2 15.07'),
  ('odinvkoree',         'Один в Корее',               'unknown', 'batch2 15.07'),
  ('sounthkoreapetrlim', 'South Korea (petrlim)',      'unknown', 'batch2 15.07'),
  ('Korea_Vakansii',     'Korea Вакансии',             'unknown', 'batch2 15.07'),
  ('LGBH6UeZdJkOWU1',    'источник (проверить ссылку)','unknown', 'batch2 15.07; CHECK: looks like a private invite hash, not a username'),
  ('gvandju',            'Кванджу (gvandju)',          'unknown', 'batch2 15.07; Gwangju'),
  ('kwangujob',          'Kwangju Job',                'unknown', 'batch2 15.07; Gwangju'),
  ('KoreaRabotaBast',    'Korea Работа Bast',          'unknown', 'batch2 15.07')
) as v(username, title, type, notes)
where not exists (
  select 1 from sources s where lower(s.username) = lower(v.username)
);
