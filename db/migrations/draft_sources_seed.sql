-- draft_sources_seed.sql
-- Owner's starting list of Telegram job chats/channels for Korea (13.07.2026).
-- tg_chat_id is left NULL — the reader (userbot) resolves and fills it on join.
-- Idempotent: each row inserted only if that username is not already present.
--
-- DRAFT ONLY. Apply after 0001–0002.
--
-- Note: 4 of 5 are Gwangju-focused (Кванджу) — the owner's initial city focus.
-- More sources are added later (Stage 5) after the owner approves each.

insert into sources (username, title, type, is_active, added_by, notes)
select v.username, v.title, v.type::source_type, true, 'owner', v.notes
from (values
  ('rabota_vsya_korea',   'Работа вся Корея',            'unknown', 'general Korea jobs'),
  ('Gwangju_si',          'Кванджу-си',                  'unknown', 'Gwangju'),
  ('gwangjugwangyeoksi',  'Кванджу (광주광역시)',         'unknown', 'Gwangju'),
  ('bolshoi_gwangju',     'Большой Кванджу',             'unknown', 'Gwangju'),
  ('gwangjukr',           'Gwangju KR',                  'unknown', 'Gwangju')
) as v(username, title, type, notes)
where not exists (
  select 1 from sources s where s.username = v.username
);
