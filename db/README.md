# korea-jobs — база данных (Neon Postgres через Vercel)

База — **Neon Postgres**, заводится через **Vercel Marketplace** (Storage → Marketplace
→ Neon → «Create New Neon Account» для свежей бесплатной базы, не связанной с другими
аккаунтами). Интеграция Vercel↔Neon сама прокидывает `DATABASE_URL` и
`DATABASE_URL_UNPOOLED` в проект.

Черновые миграции (`draft_*`) — обычный ванильный Postgres (pgcrypto, генерируемые
колонки, частичные уникальные индексы, GIN), переносятся без изменений. По правилу №4
применяются осознанно (не автоматически).

## Порядок применения

1. `migrations/draft_0001_init.sql` — расширение pgcrypto, энумы, хелперы, все таблицы
   (`sources`, `cities`, `users`, `raw_messages`, `vacancies`, `subscriptions`,
   `notifications_sent`, `config`), дедуп-функции и индексы.
2. `migrations/draft_seed.sql` — 30 городов Кореи + базовые флаги `config`.
3. `migrations/draft_sources_seed.sql` — стартовые чаты-источники владельца.

`migrations/draft_0002_rls.sql` — **опционально, для Neon НЕ применяется.** RLS был нужен
на Supabase, где PostgREST авто-экспонировал таблицы через anon-ключ. У Neon публичного
API к базе НЕТ — она достижима только по секретной `DATABASE_URL` из serverless-функций,
поэтому «харвестер чужих телефонов через anon» невозможен по конструкции. Вся защита — в
serverless-слое (проекция витринных полей, параметризованные запросы, проверка initData,
user-scoping в коде). Файл оставлен в репозитории как справка / опциональный
defense-in-depth. (Финальный ok — за 007.)

## Как накатывать миграции

- `psql "$DATABASE_URL_UNPOOLED" -f migrations/draft_0001_init.sql` (для DDL надёжнее
  прямая, непулинговая строка), затем seed и sources_seed.
- Либо встроенный SQL-браузер интеграции в дашборде Vercel (Storage → база → Query).
- Либо `neonctl` / любой миграционный инструмент Node с `DATABASE_URL`.

## Проверка после применения

- `\d+ vacancies` — сгенерированные `content_hash`/`contact_normalized` на месте; есть
  частичный уникальный индекс `uniq_vacancies_active_hash` и `idx_vacancies_notify_pending`.
- `select count(*) from cities;` → 30.
- Повторный insert в `raw_messages` с тем же `(source_id, tg_message_id)` — no-op.
- Две вакансии с одним контактом+городом+видом работы → вторая ловит `unique_violation`.
- База не открывается наружу без `DATABASE_URL` (нет публичного API-эндпоинта к данным).

## Переменные окружения (только имена; значения — в env Vercel / локальном `.env`)

- `DATABASE_URL` — пулинговая строка, для serverless-функций.
- `DATABASE_URL_UNPOOLED` — прямая строка, для миграций/DDL.

Только на сервере (Vercel). Читалка их НЕ держит. В репозиторий — только `.env.example`.

## Безопасность (007, при провижене Neon)

- **Урезанная роль для приложения.** Рантайм-`DATABASE_URL` должен указывать на роль с
  правами только DML (`select/insert/update/delete`) по нужным таблицам, БЕЗ DDL/DROP.
  Тогда даже баг/инъекция в функции не уронит схему. (На Neon RLS не защищает — это его
  замена как «defense in depth».)
- **`DATABASE_URL_UNPOOLED` (владелец схемы) — только на машине миграций**, НЕ в env
  serverless-функций.
- В Vercel пометить переменные как **Sensitive**; ни один секрет не должен получить
  префикс `VITE_` (иначе попадёт в публичный бандл фронта).
- **User-scoping — в коде:** каждый пользовательский запрос фильтруется по id из
  проверенного initData, НИКОГДА из тела/query клиента (на Neon это единственный барьер
  против кросс-юзер утечки — забытый `where user_id = …` = утечка). Жёсткий гейт ревью.
- `/vacancies` отдавать явным списком витринных колонок (без `source_id`/`raw_message_id`).
  Судьбу `contact_raw`/`contact_normalized` (чужой PII) решить с Законником + retention.

