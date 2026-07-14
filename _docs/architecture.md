# korea-jobs — архитектура (свод)

Дизайн: Рома (схема/контракты) + Саня (структура/рантаймы) + 007 (безопасность).
План проекта утверждён владельцем 13.07.2026 (хранится в личном рабочем пространстве владельца, вне репозитория).

## Инвариант безопасности (007)
Граница проходит по **хостам-секретам**, не по слоям кода:
- **Vercel** (бэкенд) — единственный держатель ключа от базы (`DATABASE_URL`, Neon) и bot-токена.
- **Worker-читалка** — держит ТОЛЬКО TG session-строку + `INGEST_SECRET`. Не имеет доступа к БД напрямую.
- Взлом дешёвого worker'а ⇒ максимум спам в `raw_messages` (ловится ИИ+дедупом), а не утечка базы.

## 4 рантайма
1. **collector/** — читалка (Node + GramJS), отдельный долгоживущий процесс, НЕ Vercel.
   Realtime `NewMessage` + `getHistory`-догон на реконнекте (идемпотентность по
   `uq_raw_source_msg`). Вступления — ручная owder-gated операция «по одному»,
   ультраконсервативный темп (эмпирика, не цифры из блогов). Пишет сырьё POST'ом
   на `/api/ingest` (Bearer `INGEST_SECRET`), не в БД напрямую. Heartbeat/liveness.
2. **api/ + lib/korea/** — Vercel serverless. Один catch-all роутер `api/index.ts`
   (1 функция из лимита 12 на Hobby). Логика — в `lib/korea/**` (тестируемо без HTTP).
3. **app/** — мини-апп (React + Vite), один Vercel-проект вместе с api (same-origin).
4. **db/** — схема (Neon Postgres через Vercel Marketplace). База закрыта, достижима
   только по `DATABASE_URL` из serverless (нет публичного API к данным); RLS не
   применяется — защита в serverless-слое; `cities` отдаётся ручкой `/api/cities`.

## Маршруты (catch-all `api/index.ts`)
| Префикс | Авторизация |
|---|---|
| `/api/cities` `/vacancies` `/me` `/subscription` | initData (`Authorization: tma`), TTL 15 мин, проекция витринных полей |
| `/api/bot/webhook` | `X-Telegram-Bot-Api-Secret-Token` == `TG_WEBHOOK_SECRET` |
| `/api/ingest` | `Bearer INGEST_SECRET`; ТОЛЬКО INSERT в `raw_messages` |
| `/api/cron/parse` `/notify` `/cleanup` | `Bearer CRON_SECRET` (внешний планировщик) |

- `requestWriteAccess()` отдельного эндпоинта не требует: результат прилетает в
  `allows_write_to_pm` следующего initData → апсерт в `users` на `/me`.
- **Проекция:** `/vacancies` НЕ отдаёт `source_id`/`raw_message_id`/внутренние id.
- `service-role` НИКОГДА не попадает во фронт-бандл.

## Развязка парсер ↔ уведомления (раздельные cron, идемпотентные, resumable)
- `/cron/parse`: `raw_messages(pending)` → Claude (строгий JSON, текст источника =
  ДАННЫЕ, игнор встроенных императивов) → апсерт `vacancies` через
  `ON CONFLICT (uniq_vacancies_active_hash)`. Пуши не шлёт.
- `/cron/notify`: свежие канонические (`notify_pending`) → матч `subscriptions`
  (GIN `city_ids`, `work_types`, `notify`, `allows_write_to_pm`, не `is_blocked`,
  минус `notifications_sent`) → троттлинг (≤~25/с, пауза на чат, уважать
  `retry_after`), на 403 → `is_blocked=true`. Окно — по `first_seen_at`, НЕ `posted_at`.
- `/cron/cleanup`: TTL-чистка `raw_messages`/неактивных `vacancies`, takedown по
  `source_id`+`raw_message_id` (retention/право на удаление — 007 + Законник).

## Внешний планировщик (важно)
Vercel Hobby cron не даёт минутную частоту (≈дневная гранулярность). `parse`/`notify`
нужны минуты ⇒ дёргаем `/api/cron/*` внешним планировщиком (Upstash QStash /
cron-job.org / GitHub Actions schedule) по `CRON_SECRET`, либо апгрейд на Pro.

## Ключевые риск-точки (сверх плана)
1. Vercel Hobby cron — минутная частота недоступна (см. выше).
2. Prompt-injection из спарсенного текста — строгий JSON-only, текст как данные.
3. Over-dedup при пустом контакте — требовать `dedup_extra`, мониторить `repost_count`.
4. Backfill = спам старьём — окно уведомлений по `first_seen_at`.
5. At-least-once + heartbeat — буфер/ретраи в ingestClient, догон историей, алерт на тихую смерть.
6. Единая точка отказа — один аккаунт-читалка; мониторинг сессии, runbook, не перегружать источниками.
7. Bot-side флуд при веерных рассылках — троттлинг, cap, мониторинг 429 бота.
8. Retention/takedown чужих телефонов — обязательный проход 007 + Законник до публичного деплоя.
9. Function timeout ≤60с на Claude-батче — малый батч, resumable по статусу строк.

## Переиспользуемые эталоны (cargobob/nhatrang)
`cargobob/api/index.ts` (catch-all) · `lib/cargobob/core/auth.ts` (initData HMAC) ·
`bot/telegram.ts` (маскировка токена) · `api/cargobob/bot/webhook.ts` (secret→дедуп→200) ·
наш `lib/korea/core/db.ts` (Neon singleton) · `nhatrang/app/src/lib/telegram.ts` (dev-мок).
