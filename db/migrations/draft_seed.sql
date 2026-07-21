-- draft_seed.sql
-- Seed: FULL administrative coverage of South Korea — 167 cities (all si + all gun,
-- incl. the metro-city gun and Sejong) with multilingual aliases, plus baseline config.
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
--   * The ORIGINAL 31 rows (sort_order 10..300) are canonical and kept verbatim; the
--     136 rows below them (sort_order 1000+) were added for full coverage. New provinces
--     introduced: region_slug 'jeonnam' (South Jeolla) and 'sejong'.
--   * HOMONYMS: name.ru carries a province qualifier ("Косон (Канвондо)"), and the
--     ambiguous RU surface (косон / кочхан / йончхон-ёнчхон) is intentionally NOT an
--     alias — lib/korea/cities/detect.ts disambiguates it by province context. Goseong
--     shares hangul+latin (고성/goseong) on BOTH rows on purpose.
--   * The parser AI prompt still returns one of the original 31 primary cities (anchor
--     for dedup); the new cities live only in city_ids via detect.ts. Do not change that.

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
  -- incheon += "хогупхо" (Ansan-cluster landmark Hogupo, Namdong-gu Incheon; from ads)
  (uuid_seed('city-incheon'),    'incheon',    '{"ru":"Инчхон","ko":"인천","en":"Incheon"}',       '["инчхон","инчон","인천","incheon","хогупхо"]',     'incheon',  30,  true),
  (uuid_seed('city-daegu'),      'daegu',      '{"ru":"Тэгу","ko":"대구","en":"Daegu"}',           '["тэгу","дэгу","대구","daegu","taegu"]',            'daegu',    40,  true),
  (uuid_seed('city-daejeon'),    'daejeon',    '{"ru":"Тэджон","ko":"대전","en":"Daejeon"}',       '["тэджон","дэджон","тэчжон","대전","daejeon","taejon"]', 'daejeon',  50,  true),
  (uuid_seed('city-gwangju'),    'gwangju',    '{"ru":"Кванджу","ko":"광주","en":"Gwangju"}',      '["кванджу","광주","gwangju","kwangju"]',            'gwangju',  60,  true),
  -- Second Gwangju: the Gyeonggi-do city near Seoul (광주 경기). NO aliases on purpose:
  -- 광주/кванджу must NOT auto-map here — the parser disambiguates by context (prompt).
  (uuid_seed('city-gwangju-gyeonggi'), 'gwangju_gyeonggi', '{"ru":"Кванджу (Кёнги)","ko":"광주 (경기)","en":"Gwangju (Gyeonggi)"}', '[]', 'gyeonggi', 65, true),
  (uuid_seed('city-ulsan'),      'ulsan',      '{"ru":"Ульсан","ko":"울산","en":"Ulsan"}',         '["ульсан","улсан","울산","ulsan"]',                 'ulsan',    70,  true),
  (uuid_seed('city-suwon'),      'suwon',      '{"ru":"Сувон","ko":"수원","en":"Suwon"}',          '["сувон","수원","suwon"]',                          'gyeonggi', 80,  true),
  -- ansan += local landmarks from ads (반월 Banwol industrial zone, 원곡동 Wongok-dong foreigner
  -- quarter, Panwol/Ttaekkol); consumer slang ("рыбка"/"чутек") intentionally NOT added (noise).
  (uuid_seed('city-ansan'),      'ansan',      '{"ru":"Ансан","ko":"안산","en":"Ansan"}',          '["ансан","안산","ansan","панволь","банволь","반월","текколь","вонгоктон"]', 'gyeonggi', 90,  true),
  (uuid_seed('city-hwaseong'),   'hwaseong',   '{"ru":"Хвасон","ko":"화성","en":"Hwaseong"}',      '["хвасон","хвасонг","화성","hwaseong"]',            'gyeonggi', 100, true),
  (uuid_seed('city-pyeongtaek'), 'pyeongtaek', '{"ru":"Пхёнтхэк","ko":"평택","en":"Pyeongtaek"}',  '["пхёнтхэк","пёнтэк","평택","pyeongtaek"]',         'gyeonggi', 110, true),
  (uuid_seed('city-bucheon'),    'bucheon',    '{"ru":"Пучхон","ko":"부천","en":"Bucheon"}',       '["пучхон","бучон","пучон","부천","bucheon"]',        'gyeonggi', 120, true),
  (uuid_seed('city-seongnam'),   'seongnam',   '{"ru":"Соннам","ko":"성남","en":"Seongnam"}',      '["соннам","сонгнам","성남","seongnam","songnam"]',  'gyeonggi', 130, true),
  (uuid_seed('city-goyang'),     'goyang',     '{"ru":"Коян","ko":"고양","en":"Goyang"}',          '["коян","гоян","고양","goyang"]',                   'gyeonggi', 140, true),
  (uuid_seed('city-yongin'),     'yongin',     '{"ru":"Ёнин","ko":"용인","en":"Yongin"}',          '["ёнин","йонгин","йонъин","용인","yongin"]',        'gyeonggi', 150, true),
  (uuid_seed('city-gimpo'),      'gimpo',      '{"ru":"Кимпхо","ko":"김포","en":"Gimpo"}',         '["кимпхо","кимпо","김포","gimpo"]',                 'gyeonggi', 160, true),
  (uuid_seed('city-paju'),       'paju',       '{"ru":"Паджу","ko":"파주","en":"Paju"}',           '["паджу","파주","paju"]',                           'gyeonggi', 170, true),
  (uuid_seed('city-namyangju'),  'namyangju',  '{"ru":"Намянджу","ko":"남양주","en":"Namyangju"}', '["намянджу","남양주","namyangju"]',                 'gyeonggi', 180, true),
  (uuid_seed('city-uijeongbu'),  'uijeongbu',  '{"ru":"Ыйджонбу","ko":"의정부","en":"Uijeongbu"}', '["ыйджонбу","уйджонбу","의정부","uijeongbu"]',      'gyeonggi', 190, true),
  (uuid_seed('city-gwangmyeong'),'gwangmyeong','{"ru":"Кванмён","ko":"광명","en":"Gwangmyeong"}',  '["кванмён","광명","gwangmyeong"]',                  'gyeonggi', 200, true),
  (uuid_seed('city-gimhae'),     'gimhae',     '{"ru":"Кимхэ","ko":"김해","en":"Gimhae"}',         '["кимхэ","кимхе","김해","gimhae"]',                 'gyeongnam',210, true),
  (uuid_seed('city-changwon'),   'changwon',   '{"ru":"Чханвон","ko":"창원","en":"Changwon"}',     '["чханвон","чангвон","чанвон","창원","changwon"]',  'gyeongnam',220, true),
  (uuid_seed('city-cheonan'),    'cheonan',    '{"ru":"Чхонан","ko":"천안","en":"Cheonan"}',       '["чхонан","чонан","천안","cheonan"]',               'chungnam', 230, true),
  (uuid_seed('city-asan'),       'asan',       '{"ru":"Асан","ko":"아산","en":"Asan"}',            '["асан","아산","asan"]',                            'chungnam', 240, true),
  (uuid_seed('city-cheongju'),   'cheongju',   '{"ru":"Чхонджу","ko":"청주","en":"Cheongju"}',     '["чхонджу","청주","cheongju"]',                     'chungbuk', 250, true),
  (uuid_seed('city-jeonju'),     'jeonju',     '{"ru":"Чонджу","ko":"전주","en":"Jeonju"}',        '["чонджу","전주","jeonju"]',                        'jeonbuk',  260, true),
  (uuid_seed('city-pohang'),     'pohang',     '{"ru":"Пхохан","ko":"포항","en":"Pohang"}',        '["пхохан","похан","포항","pohang"]',                'gyeongbuk',270, true),
  (uuid_seed('city-gumi'),       'gumi',       '{"ru":"Куми","ko":"구미","en":"Gumi"}',            '["куми","гуми","구미","gumi"]',                     'gyeongbuk',280, true),
  (uuid_seed('city-wonju'),      'wonju',      '{"ru":"Вонджу","ko":"원주","en":"Wonju"}',         '["вонджу","원주","wonju"]',                         'gangwon',  290, true),
  (uuid_seed('city-jeju'),       'jeju',       '{"ru":"Чеджу","ko":"제주","en":"Jeju"}',           '["чеджу","제주","jeju","cheju"]',                   'jeju',     300, true),
  -- sejong
  (uuid_seed('city-sejong'), 'sejong', '{"ru":"Седжон","ko":"세종","en":"Sejong"}', '["седжон","сечжон","세종","sejong","седжонг","сечжонг"]', 'sejong', 1000, true),
  -- busan
  (uuid_seed('city-gijang'), 'gijang', '{"ru":"Кичжан","ko":"기장","en":"Gijang"}', '["кичжан","кичан","기장","gijang","кичжанг","кичанг"]', 'busan', 1010, true),
  -- daegu
  (uuid_seed('city-dalseong'), 'dalseong', '{"ru":"Тальсон","ko":"달성","en":"Dalseong"}', '["тальсон","달성","dalseong","тальсонг"]', 'daegu', 1020, true),
  (uuid_seed('city-gunwi'), 'gunwi', '{"ru":"Кунви","ko":"군위","en":"Gunwi"}', '["кунви","군위","gunwi"]', 'daegu', 1030, true), -- moved from Gyeongbuk to Daegu 2023-07-01
  -- incheon
  (uuid_seed('city-ganghwa'), 'ganghwa', '{"ru":"Канхва","ko":"강화","en":"Ganghwa"}', '["канхва","강화","ganghwa"]', 'incheon', 1040, true),
  (uuid_seed('city-ongjin'), 'ongjin', '{"ru":"Онджин","ko":"옹진","en":"Ongjin"}', '["онджин","ончжин","옹진","ongjin"]', 'incheon', 1050, true),
  -- ulsan
  (uuid_seed('city-ulju'), 'ulju', '{"ru":"Ульджу","ko":"울주","en":"Ulju"}', '["ульджу","ульчжу","울주","ulju"]', 'ulsan', 1060, true),
  -- gyeonggi
  (uuid_seed('city-anseong'), 'anseong', '{"ru":"Ансон","ko":"안성","en":"Anseong"}', '["ансон","안성","anseong","ансонг"]', 'gyeonggi', 1070, true),
  (uuid_seed('city-anyang'), 'anyang', '{"ru":"Анян","ko":"안양","en":"Anyang"}', '["анян","안양","anyang","анянг"]', 'gyeonggi', 1080, true),
  (uuid_seed('city-dongducheon'), 'dongducheon', '{"ru":"Тондучхон","ko":"동두천","en":"Dongducheon"}', '["тондучхон","동두천","dongducheon"]', 'gyeonggi', 1090, true),
  (uuid_seed('city-gunpo'), 'gunpo', '{"ru":"Кунпхо","ko":"군포","en":"Gunpo"}', '["кунпхо","кунпо","군포","gunpo"]', 'gyeonggi', 1100, true),
  (uuid_seed('city-guri'), 'guri', '{"ru":"Кури","ko":"구리","en":"Guri"}', '["кури","구리","guri"]', 'gyeonggi', 1110, true),
  (uuid_seed('city-gwacheon'), 'gwacheon', '{"ru":"Квачхон","ko":"과천","en":"Gwacheon"}', '["квачхон","과천","gwacheon"]', 'gyeonggi', 1120, true),
  (uuid_seed('city-hanam'), 'hanam', '{"ru":"Ханам","ko":"하남","en":"Hanam"}', '["ханам","하남","hanam"]', 'gyeonggi', 1130, true),
  (uuid_seed('city-icheon'), 'icheon', '{"ru":"Ичхон","ko":"이천","en":"Icheon"}', '["ичхон","이천","icheon"]', 'gyeonggi', 1140, true),
  (uuid_seed('city-osan'), 'osan', '{"ru":"Осан","ko":"오산","en":"Osan"}', '["осан","오산","osan"]', 'gyeonggi', 1150, true),
  (uuid_seed('city-pocheon'), 'pocheon', '{"ru":"Пхочхон","ko":"포천","en":"Pocheon"}', '["пхочхон","почхон","포천","pocheon"]', 'gyeonggi', 1160, true),
  (uuid_seed('city-siheung'), 'siheung', '{"ru":"Сихын","ko":"시흥","en":"Siheung"}', '["сихын","시흥","siheung","сихынг"]', 'gyeonggi', 1170, true),
  (uuid_seed('city-uiwang'), 'uiwang', '{"ru":"Ыйван","ko":"의왕","en":"Uiwang"}', '["ыйван","의왕","uiwang","ыйванг"]', 'gyeonggi', 1180, true),
  (uuid_seed('city-yangju'), 'yangju', '{"ru":"Янджу","ko":"양주","en":"Yangju"}', '["янджу","янчжу","양주","yangju"]', 'gyeonggi', 1190, true),
  (uuid_seed('city-yeoju'), 'yeoju', '{"ru":"Йоджу","ko":"여주","en":"Yeoju"}', '["йоджу","ёджу","йочжу","ёчжу","еджу","ечжу","여주","yeoju"]', 'gyeonggi', 1200, true),
  (uuid_seed('city-gapyeong'), 'gapyeong', '{"ru":"Капхён","ko":"가평","en":"Gapyeong"}', '["капхён","капён","가평","gapyeong","капхёнг","капёнг"]', 'gyeonggi', 1210, true),
  (uuid_seed('city-yangpyeong'), 'yangpyeong', '{"ru":"Янпхён","ko":"양평","en":"Yangpyeong"}', '["янпхён","янпён","양평","yangpyeong","янпхёнг","янпёнг"]', 'gyeonggi', 1220, true),
  (uuid_seed('city-yeoncheon'), 'yeoncheon', '{"ru":"Ёнчхон (Кёнгидо)","ko":"연천","en":"Yeoncheon"}', '["연천","yeoncheon"]', 'gyeonggi', 1230, true),
  -- gangwon
  (uuid_seed('city-chuncheon'), 'chuncheon', '{"ru":"Чхунчхон","ko":"춘천","en":"Chuncheon"}', '["чхунчхон","춘천","chuncheon"]', 'gangwon', 1240, true),
  (uuid_seed('city-gangneung'), 'gangneung', '{"ru":"Каннын","ko":"강릉","en":"Gangneung"}', '["каннын","каннынг","강릉","gangneung"]', 'gangwon', 1250, true),
  (uuid_seed('city-donghae'), 'donghae', '{"ru":"Тонхэ","ko":"동해","en":"Donghae"}', '["тонхэ","동해","donghae"]', 'gangwon', 1260, true),
  (uuid_seed('city-sokcho'), 'sokcho', '{"ru":"Сокчхо","ko":"속초","en":"Sokcho"}', '["сокчхо","속초","sokcho"]', 'gangwon', 1270, true),
  (uuid_seed('city-samcheok'), 'samcheok', '{"ru":"Самчхок","ko":"삼척","en":"Samcheok"}', '["самчхок","삼척","samcheok"]', 'gangwon', 1280, true),
  (uuid_seed('city-taebaek'), 'taebaek', '{"ru":"Тхэбэк","ko":"태백","en":"Taebaek"}', '["тхэбэк","태백","taebaek"]', 'gangwon', 1290, true),
  (uuid_seed('city-hongcheon'), 'hongcheon', '{"ru":"Хончхон","ko":"홍천","en":"Hongcheon"}', '["хончхон","홍천","hongcheon"]', 'gangwon', 1300, true),
  (uuid_seed('city-cheorwon'), 'cheorwon', '{"ru":"Чхорвон","ko":"철원","en":"Cheorwon"}', '["чхорвон","철원","cheorwon"]', 'gangwon', 1310, true),
  (uuid_seed('city-hoengseong'), 'hoengseong', '{"ru":"Хвенсон","ko":"횡성","en":"Hoengseong"}', '["хвенсон","횡성","hoengseong","хвенсонг"]', 'gangwon', 1320, true),
  (uuid_seed('city-pyeongchang'), 'pyeongchang', '{"ru":"Пхёнчхан","ko":"평창","en":"Pyeongchang"}', '["пхёнчхан","пёнчхан","평창","pyeongchang","пхёнчханг","пёнчханг"]', 'gangwon', 1330, true),
  (uuid_seed('city-jeongseon'), 'jeongseon', '{"ru":"Чонсон","ko":"정선","en":"Jeongseon"}', '["чонсон","정선","jeongseon"]', 'gangwon', 1340, true),
  (uuid_seed('city-yeongwol'), 'yeongwol', '{"ru":"Йонволь","ko":"영월","en":"Yeongwol"}', '["йонволь","ёнволь","영월","yeongwol"]', 'gangwon', 1350, true),
  (uuid_seed('city-inje'), 'inje', '{"ru":"Индже","ko":"인제","en":"Inje"}', '["индже","инчже","인제","inje"]', 'gangwon', 1360, true),
  (uuid_seed('city-goseong_gangwon'), 'goseong_gangwon', '{"ru":"Косон (Канвондо)","ko":"고성","en":"Goseong"}', '["고성","goseong"]', 'gangwon', 1370, true),
  (uuid_seed('city-yangyang'), 'yangyang', '{"ru":"Янъян","ko":"양양","en":"Yangyang"}', '["янъян","янян","양양","yangyang","янъянг","янянг"]', 'gangwon', 1380, true),
  (uuid_seed('city-hwacheon'), 'hwacheon', '{"ru":"Хвачхон","ko":"화천","en":"Hwacheon"}', '["хвачхон","화천","hwacheon"]', 'gangwon', 1390, true),
  (uuid_seed('city-yanggu'), 'yanggu', '{"ru":"Янгу","ko":"양구","en":"Yanggu"}', '["янгу","양구","yanggu"]', 'gangwon', 1400, true),
  -- chungbuk
  (uuid_seed('city-chungju'), 'chungju', '{"ru":"Чхунджу","ko":"충주","en":"Chungju"}', '["чхунджу","чхунчжу","충주","chungju"]', 'chungbuk', 1410, true),
  (uuid_seed('city-jecheon'), 'jecheon', '{"ru":"Чечхон","ko":"제천","en":"Jecheon"}', '["чечхон","제천","jecheon"]', 'chungbuk', 1420, true),
  (uuid_seed('city-boeun'), 'boeun', '{"ru":"Поын","ko":"보은","en":"Boeun"}', '["поын","보은","boeun"]', 'chungbuk', 1430, true),
  (uuid_seed('city-danyang'), 'danyang', '{"ru":"Танян","ko":"단양","en":"Danyang"}', '["танян","단양","danyang","танянг"]', 'chungbuk', 1440, true),
  (uuid_seed('city-eumseong'), 'eumseong', '{"ru":"Ымсон","ko":"음성","en":"Eumseong"}', '["ымсон","음성","eumseong","тэсо","ымсонг"]', 'chungbuk', 1450, true),
  (uuid_seed('city-goesan'), 'goesan', '{"ru":"Квесан","ko":"괴산","en":"Goesan"}', '["квесан","괴산","goesan"]', 'chungbuk', 1460, true),
  (uuid_seed('city-jincheon'), 'jincheon', '{"ru":"Чинчхон","ko":"진천","en":"Jincheon"}', '["чинчхон","진천","jincheon"]', 'chungbuk', 1470, true),
  (uuid_seed('city-jeungpyeong'), 'jeungpyeong', '{"ru":"Чынпхён","ko":"증평","en":"Jeungpyeong"}', '["чынпхён","чынпен","증평","jeungpyeong","чынпхёнг","чынпенг"]', 'chungbuk', 1480, true),
  (uuid_seed('city-okcheon'), 'okcheon', '{"ru":"Окчхон","ko":"옥천","en":"Okcheon"}', '["окчхон","옥천","okcheon"]', 'chungbuk', 1490, true),
  (uuid_seed('city-yeongdong'), 'yeongdong', '{"ru":"Йондон","ko":"영동","en":"Yeongdong"}', '["йондон","ёндон","영동","yeongdong","йондонг","ёндонг"]', 'chungbuk', 1500, true),
  -- chungnam
  (uuid_seed('city-gongju'), 'gongju', '{"ru":"Конджу","ko":"공주","en":"Gongju"}', '["конджу","кончжу","공주","gongju"]', 'chungnam', 1510, true),
  (uuid_seed('city-boryeong'), 'boryeong', '{"ru":"Порён","ko":"보령","en":"Boryeong"}', '["порён","보령","boryeong","порёнг"]', 'chungnam', 1520, true),
  (uuid_seed('city-seosan'), 'seosan', '{"ru":"Сосан","ko":"서산","en":"Seosan"}', '["сосан","서산","seosan"]', 'chungnam', 1530, true),
  (uuid_seed('city-nonsan'), 'nonsan', '{"ru":"Нонсан","ko":"논산","en":"Nonsan"}', '["нонсан","논산","nonsan"]', 'chungnam', 1540, true),
  (uuid_seed('city-gyeryong'), 'gyeryong', '{"ru":"Керён","ko":"계룡","en":"Gyeryong"}', '["керён","계룡","gyeryong","керёнг"]', 'chungnam', 1550, true),
  (uuid_seed('city-dangjin'), 'dangjin', '{"ru":"Танджин","ko":"당진","en":"Dangjin"}', '["танджин","танчжин","당진","dangjin"]', 'chungnam', 1560, true),
  (uuid_seed('city-geumsan'), 'geumsan', '{"ru":"Кымсан","ko":"금산","en":"Geumsan"}', '["кымсан","금산","geumsan"]', 'chungnam', 1570, true),
  (uuid_seed('city-buyeo'), 'buyeo', '{"ru":"Пуё","ko":"부여","en":"Buyeo"}', '["пуё","부여","buyeo"]', 'chungnam', 1580, true),
  (uuid_seed('city-seocheon'), 'seocheon', '{"ru":"Сочхон","ko":"서천","en":"Seocheon"}', '["сочхон","서천","seocheon"]', 'chungnam', 1590, true),
  (uuid_seed('city-cheongyang'), 'cheongyang', '{"ru":"Чхонъян","ko":"청양","en":"Cheongyang"}', '["чхонъян","чхонян","청양","cheongyang","чхонъянг","чхонянг"]', 'chungnam', 1600, true),
  (uuid_seed('city-hongseong'), 'hongseong', '{"ru":"Хонсон","ko":"홍성","en":"Hongseong"}', '["хонсон","홍성","hongseong","хонсонг"]', 'chungnam', 1610, true),
  (uuid_seed('city-yesan'), 'yesan', '{"ru":"Йесан","ko":"예산","en":"Yesan"}', '["йесан","есан","예산","yesan"]', 'chungnam', 1620, true),
  (uuid_seed('city-taean'), 'taean', '{"ru":"Тхэан","ko":"태안","en":"Taean"}', '["тхэан","태안","taean"]', 'chungnam', 1630, true),
  -- jeonbuk
  (uuid_seed('city-gunsan'), 'gunsan', '{"ru":"Кунсан","ko":"군산","en":"Gunsan"}', '["кунсан","군산","gunsan"]', 'jeonbuk', 1640, true),
  (uuid_seed('city-iksan'), 'iksan', '{"ru":"Иксан","ko":"익산","en":"Iksan"}', '["иксан","익산","iksan"]', 'jeonbuk', 1650, true),
  (uuid_seed('city-jeongeup'), 'jeongeup', '{"ru":"Чонып","ko":"정읍","en":"Jeongeup"}', '["чонып","정읍","jeongeup"]', 'jeonbuk', 1660, true),
  (uuid_seed('city-namwon'), 'namwon', '{"ru":"Намвон","ko":"남원","en":"Namwon"}', '["намвон","남원","namwon"]', 'jeonbuk', 1670, true),
  (uuid_seed('city-gimje'), 'gimje', '{"ru":"Кимдже","ko":"김제","en":"Gimje"}', '["кимдже","кимчже","김제","gimje"]', 'jeonbuk', 1680, true),
  (uuid_seed('city-wanju'), 'wanju', '{"ru":"Ванджу","ko":"완주","en":"Wanju"}', '["ванджу","ванчжу","완주","wanju"]', 'jeonbuk', 1690, true),
  (uuid_seed('city-jinan'), 'jinan', '{"ru":"Чинан","ko":"진안","en":"Jinan"}', '["чинан","진안","jinan"]', 'jeonbuk', 1700, true),
  (uuid_seed('city-muju'), 'muju', '{"ru":"Муджу","ko":"무주","en":"Muju"}', '["муджу","мучжу","무주","muju"]', 'jeonbuk', 1710, true),
  (uuid_seed('city-imsil'), 'imsil', '{"ru":"Имсиль","ko":"임실","en":"Imsil"}', '["имсиль","임실","imsil"]', 'jeonbuk', 1720, true),
  (uuid_seed('city-sunchang'), 'sunchang', '{"ru":"Сунчхан","ko":"순창","en":"Sunchang"}', '["сунчхан","순창","sunchang","сунчханг"]', 'jeonbuk', 1730, true),
  (uuid_seed('city-gochang'), 'gochang', '{"ru":"Кочхан (Чолла-Пукто)","ko":"고창","en":"Gochang"}', '["고창","gochang"]', 'jeonbuk', 1740, true),
  (uuid_seed('city-buan'), 'buan', '{"ru":"Пуан","ko":"부안","en":"Buan"}', '["пуан","부안","buan"]', 'jeonbuk', 1750, true),
  (uuid_seed('city-jangsu'), 'jangsu', '{"ru":"Чансу","ko":"장수","en":"Jangsu"}', '["чансу","장수","jangsu"]', 'jeonbuk', 1760, true),
  -- jeonnam
  (uuid_seed('city-mokpo'), 'mokpo', '{"ru":"Мокпхо","ko":"목포","en":"Mokpo"}', '["мокпхо","мокпо","목포","mokpo"]', 'jeonnam', 1770, true),
  (uuid_seed('city-yeosu'), 'yeosu', '{"ru":"Йосу","ko":"여수","en":"Yeosu"}', '["йосу","ёсу","여수","yeosu"]', 'jeonnam', 1780, true),
  (uuid_seed('city-suncheon'), 'suncheon', '{"ru":"Сунчхон","ko":"순천","en":"Suncheon"}', '["сунчхон","순천","suncheon"]', 'jeonnam', 1790, true),
  (uuid_seed('city-naju'), 'naju', '{"ru":"Наджу","ko":"나주","en":"Naju"}', '["наджу","начжу","나주","naju"]', 'jeonnam', 1800, true),
  (uuid_seed('city-gwangyang'), 'gwangyang', '{"ru":"Кванъян","ko":"광양","en":"Gwangyang"}', '["кванъян","кванян","광양","gwangyang","кванъянг","кванянг"]', 'jeonnam', 1810, true),
  (uuid_seed('city-damyang'), 'damyang', '{"ru":"Тамъян","ko":"담양","en":"Damyang"}', '["тамъян","тамян","담양","damyang","тамъянг","тамянг"]', 'jeonnam', 1820, true),
  (uuid_seed('city-gokseong'), 'gokseong', '{"ru":"Коксон","ko":"곡성","en":"Gokseong"}', '["коксон","곡성","gokseong","коксонг"]', 'jeonnam', 1830, true),
  (uuid_seed('city-gurye'), 'gurye', '{"ru":"Куре","ko":"구례","en":"Gurye"}', '["куре","구례","gurye"]', 'jeonnam', 1840, true),
  (uuid_seed('city-goheung'), 'goheung', '{"ru":"Кохын","ko":"고흥","en":"Goheung"}', '["кохын","고흥","goheung","кохынг"]', 'jeonnam', 1850, true),
  (uuid_seed('city-boseong'), 'boseong', '{"ru":"Посон","ko":"보성","en":"Boseong"}', '["посон","보성","boseong","посонг"]', 'jeonnam', 1860, true),
  (uuid_seed('city-hwasun'), 'hwasun', '{"ru":"Хвасун","ko":"화순","en":"Hwasun"}', '["хвасун","화순","hwasun"]', 'jeonnam', 1870, true),
  (uuid_seed('city-jangheung'), 'jangheung', '{"ru":"Чанхын","ko":"장흥","en":"Jangheung"}', '["чанхын","장흥","jangheung","чанхынг"]', 'jeonnam', 1880, true),
  (uuid_seed('city-gangjin'), 'gangjin', '{"ru":"Канджин","ko":"강진","en":"Gangjin"}', '["канджин","канчжин","강진","gangjin"]', 'jeonnam', 1890, true),
  (uuid_seed('city-haenam'), 'haenam', '{"ru":"Хэнам","ko":"해남","en":"Haenam"}', '["хэнам","해남","haenam"]', 'jeonnam', 1900, true),
  (uuid_seed('city-yeongam'), 'yeongam', '{"ru":"Йонам","ko":"영암","en":"Yeongam"}', '["йонам","ёнам","영암","yeongam"]', 'jeonnam', 1910, true),
  (uuid_seed('city-muan'), 'muan', '{"ru":"Муан","ko":"무안","en":"Muan"}', '["муан","무안","muan"]', 'jeonnam', 1920, true),
  (uuid_seed('city-hampyeong'), 'hampyeong', '{"ru":"Хампхён","ko":"함평","en":"Hampyeong"}', '["хампхён","хампен","함평","hampyeong","хампхёнг","хампенг"]', 'jeonnam', 1930, true),
  (uuid_seed('city-yeonggwang'), 'yeonggwang', '{"ru":"Йонгван","ko":"영광","en":"Yeonggwang"}', '["йонгван","ёнгван","영광","yeonggwang","йонгванг","ёнгванг"]', 'jeonnam', 1940, true),
  (uuid_seed('city-jangseong'), 'jangseong', '{"ru":"Чансон","ko":"장성","en":"Jangseong"}', '["чансон","장성","jangseong","чансонг"]', 'jeonnam', 1950, true),
  (uuid_seed('city-wando'), 'wando', '{"ru":"Вандо","ko":"완도","en":"Wando"}', '["вандо","완도","wando"]', 'jeonnam', 1960, true),
  (uuid_seed('city-jindo'), 'jindo', '{"ru":"Чиндо","ko":"진도","en":"Jindo"}', '["чиндо","진도","jindo"]', 'jeonnam', 1970, true),
  (uuid_seed('city-sinan'), 'sinan', '{"ru":"Синан","ko":"신안","en":"Sinan"}', '["синан","신안","sinan"]', 'jeonnam', 1980, true),
  -- gyeongbuk
  (uuid_seed('city-gyeongju'), 'gyeongju', '{"ru":"Кёнджу","ko":"경주","en":"Gyeongju"}', '["кёнджу","кёнчжу","경주","gyeongju"]', 'gyeongbuk', 1990, true),
  (uuid_seed('city-gimcheon'), 'gimcheon', '{"ru":"Кимчхон","ko":"김천","en":"Gimcheon"}', '["кимчхон","김천","gimcheon"]', 'gyeongbuk', 2000, true),
  (uuid_seed('city-andong'), 'andong', '{"ru":"Андон","ko":"안동","en":"Andong"}', '["андон","안동","andong","андонг"]', 'gyeongbuk', 2010, true),
  (uuid_seed('city-yeongju'), 'yeongju', '{"ru":"Йонджу","ko":"영주","en":"Yeongju"}', '["йонджу","ёнджу","йончжу","ёнчжу","영주","yeongju"]', 'gyeongbuk', 2020, true),
  (uuid_seed('city-yeongcheon'), 'yeongcheon', '{"ru":"Ёнчхон (Кёнсан-Пукто)","ko":"영천","en":"Yeongcheon"}', '["영천","yeongcheon"]', 'gyeongbuk', 2030, true),
  (uuid_seed('city-sangju'), 'sangju', '{"ru":"Санджу","ko":"상주","en":"Sangju"}', '["санджу","санчжу","상주","sangju"]', 'gyeongbuk', 2040, true),
  (uuid_seed('city-mungyeong'), 'mungyeong', '{"ru":"Мунгён","ko":"문경","en":"Mungyeong"}', '["мунгён","문경","mungyeong","мунгёнг"]', 'gyeongbuk', 2050, true),
  (uuid_seed('city-gyeongsan'), 'gyeongsan', '{"ru":"Кёнсан","ko":"경산","en":"Gyeongsan"}', '["кёнсан","경산","gyeongsan"]', 'gyeongbuk', 2060, true),
  (uuid_seed('city-uiseong'), 'uiseong', '{"ru":"Ыйсон","ko":"의성","en":"Uiseong"}', '["ыйсон","의성","uiseong","ыйсонг"]', 'gyeongbuk', 2070, true),
  (uuid_seed('city-cheongsong'), 'cheongsong', '{"ru":"Чхонсон","ko":"청송","en":"Cheongsong"}', '["чхонсон","청송","cheongsong","чхонсонг"]', 'gyeongbuk', 2080, true),
  (uuid_seed('city-yeongyang'), 'yeongyang', '{"ru":"Йонъян","ko":"영양","en":"Yeongyang"}', '["йонъян","ёнъян","йонян","ёнян","영양","yeongyang","йонъянг","ёнъянг","йонянг","ёнянг"]', 'gyeongbuk', 2090, true),
  (uuid_seed('city-yeongdeok'), 'yeongdeok', '{"ru":"Йондок","ko":"영덕","en":"Yeongdeok"}', '["йондок","ёндок","영덕","yeongdeok"]', 'gyeongbuk', 2100, true),
  (uuid_seed('city-cheongdo'), 'cheongdo', '{"ru":"Чхондо","ko":"청도","en":"Cheongdo"}', '["чхондо","청도","cheongdo"]', 'gyeongbuk', 2110, true),
  (uuid_seed('city-goryeong'), 'goryeong', '{"ru":"Корён","ko":"고령","en":"Goryeong"}', '["корён","고령","goryeong","корёнг"]', 'gyeongbuk', 2120, true),
  (uuid_seed('city-seongju'), 'seongju', '{"ru":"Сонджу","ko":"성주","en":"Seongju"}', '["сонджу","сончжу","성주","seongju"]', 'gyeongbuk', 2130, true),
  (uuid_seed('city-chilgok'), 'chilgok', '{"ru":"Чхильгок","ko":"칠곡","en":"Chilgok"}', '["чхильгок","칠곡","chilgok"]', 'gyeongbuk', 2140, true),
  (uuid_seed('city-yecheon'), 'yecheon', '{"ru":"Йечхон","ko":"예천","en":"Yecheon"}', '["йечхон","ечхон","예천","yecheon"]', 'gyeongbuk', 2150, true),
  (uuid_seed('city-bonghwa'), 'bonghwa', '{"ru":"Понхва","ko":"봉화","en":"Bonghwa"}', '["понхва","봉화","bonghwa"]', 'gyeongbuk', 2160, true),
  (uuid_seed('city-uljin'), 'uljin', '{"ru":"Ульчин","ko":"울진","en":"Uljin"}', '["ульчин","울진","uljin"]', 'gyeongbuk', 2170, true),
  (uuid_seed('city-ulleung'), 'ulleung', '{"ru":"Уллын","ko":"울릉","en":"Ulleung"}', '["уллын","уллынг","울릉","ulleung"]', 'gyeongbuk', 2180, true),
  -- gyeongnam
  (uuid_seed('city-jinju'), 'jinju', '{"ru":"Чинджу","ko":"진주","en":"Jinju"}', '["чинджу","чинчжу","진주","jinju"]', 'gyeongnam', 2190, true),
  (uuid_seed('city-tongyeong'), 'tongyeong', '{"ru":"Тхонъён","ko":"통영","en":"Tongyeong"}', '["тхонъён","тонъён","тонён","통영","tongyeong","тхонъёнг","тонъёнг","тонёнг"]', 'gyeongnam', 2200, true),
  (uuid_seed('city-sacheon'), 'sacheon', '{"ru":"Сачхон","ko":"사천","en":"Sacheon"}', '["сачхон","사천","sacheon"]', 'gyeongnam', 2210, true),
  (uuid_seed('city-miryang'), 'miryang', '{"ru":"Мирян","ko":"밀양","en":"Miryang"}', '["мирян","밀양","miryang","мирянг"]', 'gyeongnam', 2220, true),
  (uuid_seed('city-geoje'), 'geoje', '{"ru":"Кодже","ko":"거제","en":"Geoje"}', '["кодже","кочже","거제","geoje"]', 'gyeongnam', 2230, true),
  (uuid_seed('city-yangsan'), 'yangsan', '{"ru":"Янсан","ko":"양산","en":"Yangsan"}', '["янсан","양산","yangsan"]', 'gyeongnam', 2240, true),
  (uuid_seed('city-uiryeong'), 'uiryeong', '{"ru":"Ыйрён","ko":"의령","en":"Uiryeong"}', '["ыйрён","의령","uiryeong","ыйрёнг"]', 'gyeongnam', 2250, true),
  (uuid_seed('city-haman'), 'haman', '{"ru":"Хаман","ko":"함안","en":"Haman"}', '["хаман","함안","haman"]', 'gyeongnam', 2260, true),
  (uuid_seed('city-changnyeong'), 'changnyeong', '{"ru":"Чханнён","ko":"창녕","en":"Changnyeong"}', '["чханнён","чаннён","창녕","changnyeong","чханнёнг","чаннёнг"]', 'gyeongnam', 2270, true),
  (uuid_seed('city-goseong_gyeongnam'), 'goseong_gyeongnam', '{"ru":"Косон (Кёнсан-Намдо)","ko":"고성","en":"Goseong"}', '["고성","goseong"]', 'gyeongnam', 2280, true),
  (uuid_seed('city-namhae'), 'namhae', '{"ru":"Намхэ","ko":"남해","en":"Namhae"}', '["намхэ","남해","namhae"]', 'gyeongnam', 2290, true),
  (uuid_seed('city-hadong'), 'hadong', '{"ru":"Хадон","ko":"하동","en":"Hadong"}', '["хадон","하동","hadong","хадонг"]', 'gyeongnam', 2300, true),
  (uuid_seed('city-sancheong'), 'sancheong', '{"ru":"Санчхон","ko":"산청","en":"Sancheong"}', '["санчхон","산청","sancheong","санчхонг"]', 'gyeongnam', 2310, true),
  (uuid_seed('city-hamyang'), 'hamyang', '{"ru":"Хамян","ko":"함양","en":"Hamyang"}', '["хамян","함양","hamyang","хамянг"]', 'gyeongnam', 2320, true),
  (uuid_seed('city-geochang'), 'geochang', '{"ru":"Кочхан (Кёнсан-Намдо)","ko":"거창","en":"Geochang"}', '["거창","geochang"]', 'gyeongnam', 2330, true),
  (uuid_seed('city-hapcheon'), 'hapcheon', '{"ru":"Хапчхон","ko":"합천","en":"Hapcheon"}', '["хапчхон","합천","hapcheon"]', 'gyeongnam', 2340, true),
  -- jeju
  (uuid_seed('city-seogwipo'), 'seogwipo', '{"ru":"Согвипхо","ko":"서귀포","en":"Seogwipo"}', '["согвипхо","서귀포","seogwipo"]', 'jeju', 2350, true)

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
-- DO NOTHING, not DO UPDATE: these are FRESH-DB defaults only. apply.mjs re-runs the whole
-- migration list on every apply, and DO UPDATE silently reverted owner-tuned config values
-- (bit us 2026-07-19: vacancy_ttl_days=1 rolled back to 14 by an unrelated migration run).
on conflict (key) do nothing;

commit;

drop function if exists uuid_seed(text);
