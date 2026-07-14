-- draft_seed.sql
-- Seed: 30 largest / most job-relevant Korean cities with multilingual aliases,
-- plus baseline config flags.
--
-- DRAFT ONLY. Apply after 0001–0002. See supabase/README.md.
--
-- Notes:
--   * Deterministic ids via uuid_seed() (same trick as nhatrang) so city ids are
--     stable across environments and subscriptions can rely on them.
--   * aliases are LOWERCASED (ru/ko/en/translit). Korean has no case. They are a
--     *helper* for normalization; the parser (AI) is the primary city picker.
--   * Ambiguous translit (e.g. RU "чонджу" for both Jeonju & Cheongju) is left to
--     the AI to disambiguate by context; do not auto-map on those aliases alone.

create or replace function uuid_seed(key text)
returns uuid
language sql
immutable
as $$
  with h as (
    select substr(
      encode(sha256(convert_to('korea-jobs:' || key, 'UTF8')), 'hex'), 1, 32
    ) as hex
  ),
  fixed as (
    select overlay(
             overlay(hex placing '5' from 13 for 1)
             placing '8' from 17 for 1
           ) as hex
    from h
  )
  select (
    substr(hex, 1, 8)  || '-' || substr(hex, 9, 4)  || '-' ||
    substr(hex, 13, 4) || '-' || substr(hex, 17, 4) || '-' || substr(hex, 21, 12)
  )::uuid
  from fixed;
$$;

begin;

insert into cities (id, slug, name, aliases, region_slug, sort_order, is_active) values
  (uuid_seed('city-seoul'),      'seoul',      '{"ru":"Сеул","ko":"서울","en":"Seoul"}',           '["сеул","서울","seoul","seul"]',                    'seoul',    10,  true),
  (uuid_seed('city-busan'),      'busan',      '{"ru":"Пусан","ko":"부산","en":"Busan"}',          '["пусан","бусан","부산","busan","pusan"]',          'busan',    20,  true),
  (uuid_seed('city-incheon'),    'incheon',    '{"ru":"Инчхон","ko":"인천","en":"Incheon"}',       '["инчхон","инчон","인천","incheon"]',               'incheon',  30,  true),
  (uuid_seed('city-daegu'),      'daegu',      '{"ru":"Тэгу","ko":"대구","en":"Daegu"}',           '["тэгу","дэгу","대구","daegu","taegu"]',            'daegu',    40,  true),
  (uuid_seed('city-daejeon'),    'daejeon',    '{"ru":"Тэджон","ko":"대전","en":"Daejeon"}',       '["тэджон","дэджон","대전","daejeon","taejon"]',     'daejeon',  50,  true),
  (uuid_seed('city-gwangju'),    'gwangju',    '{"ru":"Кванджу","ko":"광주","en":"Gwangju"}',      '["кванджу","광주","gwangju","kwangju"]',            'gwangju',  60,  true),
  (uuid_seed('city-ulsan'),      'ulsan',      '{"ru":"Ульсан","ko":"울산","en":"Ulsan"}',         '["ульсан","улсан","울산","ulsan"]',                 'ulsan',    70,  true),
  (uuid_seed('city-suwon'),      'suwon',      '{"ru":"Сувон","ko":"수원","en":"Suwon"}',          '["сувон","수원","suwon"]',                          'gyeonggi', 80,  true),
  (uuid_seed('city-ansan'),      'ansan',      '{"ru":"Ансан","ko":"안산","en":"Ansan"}',          '["ансан","안산","ansan"]',                          'gyeonggi', 90,  true),
  (uuid_seed('city-hwaseong'),   'hwaseong',   '{"ru":"Хвасон","ko":"화성","en":"Hwaseong"}',      '["хвасон","хвасонг","화성","hwaseong"]',            'gyeonggi', 100, true),
  (uuid_seed('city-pyeongtaek'), 'pyeongtaek', '{"ru":"Пхёнтхэк","ko":"평택","en":"Pyeongtaek"}',  '["пхёнтхэк","пёнтэк","평택","pyeongtaek"]',         'gyeonggi', 110, true),
  (uuid_seed('city-bucheon'),    'bucheon',    '{"ru":"Пучхон","ko":"부천","en":"Bucheon"}',       '["пучхон","бучон","부천","bucheon"]',               'gyeonggi', 120, true),
  (uuid_seed('city-seongnam'),   'seongnam',   '{"ru":"Соннам","ko":"성남","en":"Seongnam"}',      '["соннам","сонгнам","성남","seongnam"]',            'gyeonggi', 130, true),
  (uuid_seed('city-goyang'),     'goyang',     '{"ru":"Коян","ko":"고양","en":"Goyang"}',          '["коян","гоян","고양","goyang"]',                   'gyeonggi', 140, true),
  (uuid_seed('city-yongin'),     'yongin',     '{"ru":"Ёнин","ko":"용인","en":"Yongin"}',          '["ёнин","йонгин","용인","yongin"]',                 'gyeonggi', 150, true),
  (uuid_seed('city-gimpo'),      'gimpo',      '{"ru":"Кимпхо","ko":"김포","en":"Gimpo"}',         '["кимпхо","кимпо","김포","gimpo"]',                 'gyeonggi', 160, true),
  (uuid_seed('city-paju'),       'paju',       '{"ru":"Паджу","ko":"파주","en":"Paju"}',           '["паджу","파주","paju"]',                           'gyeonggi', 170, true),
  (uuid_seed('city-namyangju'),  'namyangju',  '{"ru":"Намянджу","ko":"남양주","en":"Namyangju"}', '["намянджу","남양주","namyangju"]',                 'gyeonggi', 180, true),
  (uuid_seed('city-uijeongbu'),  'uijeongbu',  '{"ru":"Ыйджонбу","ko":"의정부","en":"Uijeongbu"}', '["ыйджонбу","уйджонбу","의정부","uijeongbu"]',      'gyeonggi', 190, true),
  (uuid_seed('city-gwangmyeong'),'gwangmyeong','{"ru":"Кванмён","ko":"광명","en":"Gwangmyeong"}',  '["кванмён","광명","gwangmyeong"]',                  'gyeonggi', 200, true),
  (uuid_seed('city-gimhae'),     'gimhae',     '{"ru":"Кимхэ","ko":"김해","en":"Gimhae"}',         '["кимхэ","김해","gimhae"]',                         'gyeongnam',210, true),
  (uuid_seed('city-changwon'),   'changwon',   '{"ru":"Чханвон","ko":"창원","en":"Changwon"}',     '["чханвон","чангвон","창원","changwon"]',           'gyeongnam',220, true),
  (uuid_seed('city-cheonan'),    'cheonan',    '{"ru":"Чхонан","ko":"천안","en":"Cheonan"}',       '["чхонан","чонан","천안","cheonan"]',               'chungnam', 230, true),
  (uuid_seed('city-asan'),       'asan',       '{"ru":"Асан","ko":"아산","en":"Asan"}',            '["асан","아산","asan"]',                            'chungnam', 240, true),
  (uuid_seed('city-cheongju'),   'cheongju',   '{"ru":"Чхонджу","ko":"청주","en":"Cheongju"}',     '["чхонджу","청주","cheongju"]',                     'chungbuk', 250, true),
  (uuid_seed('city-jeonju'),     'jeonju',     '{"ru":"Чонджу","ko":"전주","en":"Jeonju"}',        '["чонджу","전주","jeonju"]',                        'jeonbuk',  260, true),
  (uuid_seed('city-pohang'),     'pohang',     '{"ru":"Пхохан","ko":"포항","en":"Pohang"}',        '["пхохан","похан","포항","pohang"]',                'gyeongbuk',270, true),
  (uuid_seed('city-gumi'),       'gumi',       '{"ru":"Куми","ko":"구미","en":"Gumi"}',            '["куми","гуми","구미","gumi"]',                     'gyeongbuk',280, true),
  (uuid_seed('city-wonju'),      'wonju',      '{"ru":"Вонджу","ko":"원주","en":"Wonju"}',         '["вонджу","원주","wonju"]',                         'gangwon',  290, true),
  (uuid_seed('city-jeju'),       'jeju',       '{"ru":"Чеджу","ko":"제주","en":"Jeju"}',           '["чеджу","제주","jeju","cheju"]',                   'jeju',     300, true)
on conflict (slug) do update set
  name        = excluded.name,
  aliases     = excluded.aliases,
  region_slug = excluded.region_slug,
  sort_order  = excluded.sort_order,
  is_active   = excluded.is_active;

-- Baseline config flags (tune later).
insert into config (key, value) values
  ('vacancy_ttl_days',    '14'),      -- after N days a vacancy goes is_active=false (frees the dedup slot)
  ('parser_batch_size',   '20'),      -- raw_messages per Claude batch
  ('parser_model',        '"haiku"'), -- alias; exact model id via the claude-api skill at code time
  ('notify_enabled',      'true'),    -- global push kill-switch
  ('reader_min_text_len', '20')       -- skip ultra-short messages before AI (cost guard)
on conflict (key) do update set value = excluded.value;

commit;

drop function if exists uuid_seed(text);
