// lib/korea/scheduled/parse.ts
//
// The PURE half of the owner's «отложенные публикации» tool: everything that turns one
// /post message into a validated plan, and everything that turns that plan back into human
// Russian for the preview. No DB, no Bot API, no clock of its own (the caller passes `now`)
// — so all of it is unit-testable.
//
// THE COMMAND (owner tool, admin-only; see lib/korea/bot/webhook.ts for the wiring)
// One message — or the CAPTION of one photo, which arrives in the SAME update, which is why
// this tool needs no dialogue state (a stateful "now send me the text" flow would collide
// with the inbox that catches every non-command message):
//
//   /post
//   когда: завтра 09:00
//   повтор: каждые 24 часа, 5 раз
//   тип: обычное
//   город: Ансан
//   работа: завод
//   контакт: @nickname
//   уведомить: да
//   ---
//   Заголовок объявления
//   Основной текст…
//
// Only «когда» and the text after `---` are required. Times are ALWAYS Asia/Seoul in the
// conversation with the owner (his audience lives in Korea); storage is UTC. Seoul has no DST,
// so the conversion is a constant +9h (same assumption as core/time.ts).
//
// LEGAL RULES BAKED IN HERE (Законник, 2026-08-01 — do not "improve" them away):
//   * a paid placement is labelled with the word «Реклама» — not "промо", not "спонсор", not
//     "топ" — and the label rides ALONG WITH THE TEXT (see promoDescription), so it cannot get
//     lost if a client forgets to render the badge;
//   * the two disclaimers are reused VERBATIM from the already-published Partners page
//     (app/src/i18n/ru.ts → partners.ads.disclaimer / partners.jobs.verifyNote);
//   * a promo is never made to look "better" than an ordinary card (no pin, no boost, no frame)
//     — that is a quality signal, and a quality signal must not be for sale;
//   * a repeat does NOT re-date the old card: it publishes anew and archives the previous one.
//     The preview says so in plain Russian, because that is a thing the owner must not discover
//     afterwards;
//   * a text that limits the audience by GENDER or AGE gets a warning in the preview (in Korea
//     that is forbidden in hiring ads). We warn, we do not block — the owner decides.

/** How the post is published. 'ad' = ordinary listing, 'promo' = paid «Реклама» placement. */
export type PostKind = 'ad' | 'promo';

/** The ad fields we persist in scheduled_posts.payload — mirrors ads/input.ts AdFields shape. */
export interface PostPayload {
  title: string;
  description: string;
  contactRaw: string | null;
  contactKind: string | null;
  workType: string;
  /** Raw city as typed by the owner; resolved against the cities directory outside this module. */
  cityInput: string | null;
}

export interface PostPlan {
  kind: PostKind;
  payload: PostPayload;
  /** First publication, as a UTC instant. */
  startAt: Date;
  /** null = publish once. */
  intervalMinutes: number | null;
  totalRuns: number;
  /** Push to matching subscribers through the ordinary notify worker. ALWAYS false for promo. */
  notify: boolean;
  /** Gender/age phrases found in the text — shown as a warning, never a block. */
  warnings: string[];
}

export type PostParseResult = { ok: true; plan: PostPlan } | { ok: false; error: string };

// ─────────────────────────────────────────────────────────────────────────────
// Limits
// ─────────────────────────────────────────────────────────────────────────────

/** Title cap — same as a user ad (ads/input.ts). */
export const TITLE_MAX = 120;
/** Description cap — same as a user ad. */
export const DESCRIPTION_MAX = 4000;
/** Contact cap — same as a user ad. */
export const CONTACT_MAX = 300;
/** Smallest allowed gap between repeats: a typo like «каждые 2 минуты» must not become a flood. */
export const MIN_INTERVAL_MINUTES = 30;
/** Largest allowed gap (60 days). */
export const MAX_INTERVAL_MINUTES = 60 * 24 * 60;
/** Largest number of publications one schedule may make. */
export const MAX_TOTAL_RUNS = 30;
/** How far ahead a first publication may be planned (a year). */
export const MAX_HORIZON_MS = 366 * 24 * 3600 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Legal copy — VERBATIM from the published Partners page. Do not paraphrase.
// ─────────────────────────────────────────────────────────────────────────────

/** app/src/i18n/ru.ts → partners.ads.disclaimer */
export const PROMO_DISCLAIMER = 'Реклама. Условия и исполнение — на стороне партнёра, мы не сторона сделки.';
/** app/src/i18n/ru.ts → partners.jobs.verifyNote */
export const PROMO_VERIFY_NOTE =
  'Оплата размещения не означает, что мы проверили работодателя или условия работы. Мы проверяем только, кто размещает рекламу.';

/**
 * The text a PROMO card actually carries: the owner's text plus the two disclaimers, appended
 * once. The visual «Реклама» badge (VacancyView.promo) is a SECOND, independent carrier of the
 * label — belt and braces: if a client ever fails to render the badge, the label is still in the
 * text, and a card that is shown without its label is the one thing that is not allowed.
 */
export function promoDescription(text: string): string {
  return `${text}\n\n${PROMO_DISCLAIMER}\n${PROMO_VERIFY_NOTE}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Asia/Seoul wall clock (no DST → a constant offset, exactly like core/time.ts)
// ─────────────────────────────────────────────────────────────────────────────

const SEOUL_OFFSET_MS = 9 * 3600 * 1000;

interface SeoulParts {
  y: number;
  m: number; // 1-12
  d: number;
  hh: number;
  mm: number;
}

/** The Seoul wall clock at an instant. */
export function seoulParts(at: Date): SeoulParts {
  const t = new Date(at.getTime() + SEOUL_OFFSET_MS);
  return {
    y: t.getUTCFullYear(),
    m: t.getUTCMonth() + 1,
    d: t.getUTCDate(),
    hh: t.getUTCHours(),
    mm: t.getUTCMinutes(),
  };
}

/** The UTC instant of a Seoul wall-clock moment. */
export function fromSeoul(y: number, m: number, d: number, hh: number, mm: number): Date {
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - SEOUL_OFFSET_MS);
}

const MONTHS_GEN = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

const two = (n: number): string => String(n).padStart(2, '0');

/** «2 августа, 09:00» — the Seoul wall clock of an instant, for the owner's eyes. */
export function formatSeoul(at: Date): string {
  const p = seoulParts(at);
  return `${p.d} ${MONTHS_GEN[p.m - 1]}, ${two(p.hh)}:${two(p.mm)}`;
}

/** Russian plural: plural(2, 'раз', 'раза', 'раз') -> 'раза'. */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/** «каждые 24 часа» / «каждый день» / «каждые 90 минут» — the gap between repeats, in words. */
export function humanInterval(minutes: number): string {
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return days === 1 ? 'каждый день' : `каждые ${days} ${plural(days, 'день', 'дня', 'дней')}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? 'каждый час' : `каждые ${hours} ${plural(hours, 'час', 'часа', 'часов')}`;
  }
  return `каждые ${minutes} ${plural(minutes, 'минуту', 'минуты', 'минут')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// «когда» — when to publish
// ─────────────────────────────────────────────────────────────────────────────

const RELATIVE_UNITS: { re: RegExp; minutes: number }[] = [
  { re: /^(?:мин|минут[аыу]?|минуты)$/i, minutes: 1 },
  { re: /^(?:ч|час|часа|часов)$/i, minutes: 60 },
  { re: /^(?:д|дн[еяй]|день|дня|дней|суток|сутки)$/i, minutes: 60 * 24 },
];

/**
 * Resolve «когда» into a UTC instant. Accepted (all wall-clock Asia/Seoul):
 *   «сейчас», «через 2 часа», «через 30 минут», «через 3 дня»
 *   «сегодня 18:00», «завтра 09:00», «послезавтра 09:00»
 *   «02.08 09:00», «02.08.2026 09:00», «2026-08-02 09:00»
 *   «09:00» (today, or tomorrow when that hour has already passed)
 * Returns null when nothing matched; the caller turns that into a helpful error.
 */
export function parseWhen(raw: string, now: Date): Date | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return null;
  if (s === 'сейчас' || s === 'now') return new Date(now.getTime());

  // «через N <единица>»
  const rel = /^через\s+(\d{1,4})\s*([а-яё]+)$/i.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2] ?? '';
    const found = RELATIVE_UNITS.find((u) => u.re.test(unit));
    if (!found || !Number.isFinite(n) || n <= 0) return null;
    return new Date(now.getTime() + n * found.minutes * 60_000);
  }

  const time = /(\d{1,2}):(\d{2})/.exec(s);
  const hh = time ? Number(time[1]) : 0;
  const mm = time ? Number(time[2]) : 0;
  if (time && (hh > 23 || mm > 59)) return null;

  const p = seoulParts(now);

  // «сегодня|завтра|послезавтра HH:MM».
  // NOT `\b`: in JavaScript a word boundary is ASCII-only, so «завтра» followed by a space has NO
  // boundary after the Cyrillic «а» and the whole branch would never fire (it did not — the tests
  // caught it). A negative lookahead for another Cyrillic letter is the honest equivalent.
  const dayWord = /^(сегодня|завтра|послезавтра)(?![а-яё])/.exec(s);
  if (dayWord) {
    if (!time) return null; // a day without an hour is ambiguous — ask for the hour
    const shift = dayWord[1] === 'сегодня' ? 0 : dayWord[1] === 'завтра' ? 1 : 2;
    return fromSeoul(p.y, p.m, p.d + shift, hh, mm);
  }

  // «2026-08-02 09:00»
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return fromSeoul(Number(iso[1]), Number(iso[2]), Number(iso[3]), hh, mm);

  // «02.08 09:00» / «02.08.2026 09:00» (a bare DD.MM that already passed rolls to next year)
  const dot = /^(\d{1,2})[.](\d{1,2})(?:[.](\d{2,4}))?/.exec(s);
  if (dot) {
    const d = Number(dot[1]);
    const m = Number(dot[2]);
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    if (dot[3]) {
      const yRaw = Number(dot[3]);
      const y = yRaw < 100 ? 2000 + yRaw : yRaw;
      return fromSeoul(y, m, d, hh, mm);
    }
    const thisYear = fromSeoul(p.y, m, d, hh, mm);
    return thisYear.getTime() >= now.getTime() ? thisYear : fromSeoul(p.y + 1, m, d, hh, mm);
  }

  // Bare «HH:MM» — today, or tomorrow when that hour is already behind us.
  if (time && /^\d{1,2}:\d{2}$/.test(s)) {
    const today = fromSeoul(p.y, p.m, p.d, hh, mm);
    return today.getTime() >= now.getTime() ? today : fromSeoul(p.y, p.m, p.d + 1, hh, mm);
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// «повтор» — repeats
// ─────────────────────────────────────────────────────────────────────────────

export interface RepeatSpec {
  intervalMinutes: number | null;
  totalRuns: number;
}

export type RepeatResult = { ok: true; repeat: RepeatSpec } | { ok: false; error: string };

const NO_REPEAT = /^(нет|без повтора|один раз|однократно|no|none)$/i;

/**
 * Resolve «повтор». Accepted:
 *   «нет» / «один раз»            → publish once
 *   «каждые 24 часа, 5 раз»       → 5 publications, a day apart
 *   «каждый день, 3 раза»         → same, the «каждый»/«каждые» form without a number
 * A gap with no count is REFUSED on purpose: an endless repeat is not something to guess at.
 */
export function parseRepeat(raw: string): RepeatResult {
  const s = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s || NO_REPEAT.test(s)) return { ok: true, repeat: { intervalMinutes: null, totalRuns: 1 } };

  // `[а-яё]*`, never `\w*`: JavaScript's \w is ASCII-only, so «кажд\w*» matched «кажд» and then
  // demanded whitespace — «каждые 24 часа» never parsed at all.
  const gap = /кажд[а-яё]*\s+(?:(\d{1,4})\s*)?([а-яё]+)/i.exec(s);
  if (!gap) {
    return {
      ok: false,
      error: 'Не понял «повтор». Примеры: «нет», «каждые 24 часа, 5 раз», «каждый день, 3 раза».',
    };
  }
  const n = gap[1] ? Number(gap[1]) : 1;
  const unit = gap[2] ?? '';
  const found = RELATIVE_UNITS.find((u) => u.re.test(unit));
  if (!found || !Number.isFinite(n) || n <= 0) {
    return { ok: false, error: 'Не понял, как часто повторять. Пример: «каждые 24 часа, 5 раз».' };
  }
  const intervalMinutes = n * found.minutes;
  if (intervalMinutes < MIN_INTERVAL_MINUTES) {
    return { ok: false, error: `Слишком часто. Минимальный промежуток — ${MIN_INTERVAL_MINUTES} минут.` };
  }
  if (intervalMinutes > MAX_INTERVAL_MINUTES) {
    return { ok: false, error: 'Слишком редко — промежуток больше 60 дней.' };
  }

  const times = /(\d{1,3})\s*раз/i.exec(s);
  if (!times) {
    return {
      ok: false,
      error: 'Сколько раз повторить? Допиши, например: «каждые 24 часа, 5 раз».',
    };
  }
  const totalRuns = Number(times[1]);
  if (!Number.isFinite(totalRuns) || totalRuns < 2) {
    return { ok: false, error: 'Повтор — это минимум 2 публикации. Или напиши «повтор: нет».' };
  }
  if (totalRuns > MAX_TOTAL_RUNS) {
    return { ok: false, error: `Слишком много повторов, максимум ${MAX_TOTAL_RUNS}.` };
  }
  return { ok: true, repeat: { intervalMinutes, totalRuns } };
}

// ─────────────────────────────────────────────────────────────────────────────
// «работа» / «тип» / «уведомить» / контакт
// ─────────────────────────────────────────────────────────────────────────────

/** RU words the owner may type in «работа», mapped onto the work_type enum. */
const WORK_ALIASES: Record<string, string> = {
  завод: 'factory',
  фабрика: 'factory',
  factory: 'factory',
  стройка: 'construction',
  строительство: 'construction',
  construction: 'construction',
  поле: 'agriculture',
  ферма: 'agriculture',
  сельское: 'agriculture',
  agriculture: 'agriculture',
  рыбзавод: 'fishery',
  рыба: 'fishery',
  fishery: 'fishery',
  пищевка: 'food',
  пищёвка: 'food',
  еда: 'food',
  food: 'food',
  склад: 'logistics',
  логистика: 'logistics',
  logistics: 'logistics',
  общепит: 'restaurant',
  ресторан: 'restaurant',
  кафе: 'restaurant',
  restaurant: 'restaurant',
  уборка: 'cleaning',
  клининг: 'cleaning',
  cleaning: 'cleaning',
  уход: 'caregiving',
  caregiving: 'caregiving',
  отель: 'hotel',
  гостиница: 'hotel',
  hotel: 'hotel',
  услуги: 'services',
  сервис: 'services',
  services: 'services',
  другое: 'other',
  other: 'other',
};

/** Resolve «работа» to a work_type slug, or null when the word is not one we know. */
export function parseWorkType(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/ё/g, 'е');
  if (!s) return null;
  const direct = WORK_ALIASES[s];
  if (direct) return direct;
  // «поле, ферма» / «завод (пищевой)» — take the first word.
  const first = s.split(/[\s,(/]+/)[0] ?? '';
  return WORK_ALIASES[first] ?? null;
}

/** Guess contact_kind from the contact string (same vocabulary as the parser's CONTACT_KINDS). */
export function guessContactKind(contact: string): string {
  const s = contact.trim().toLowerCase();
  if (/^@[a-z0-9_]{3,}/i.test(s) || /t\.me\//.test(s) || /telegram/.test(s)) return 'telegram';
  if (/kakao|카톡|카카오/.test(s)) return 'kakao';
  if (/whats\s?app|wa\.me/.test(s)) return 'whatsapp';
  if (/^\+?\d[\d\s().-]{5,}$/.test(s)) return 'phone';
  return 'other';
}

// ─────────────────────────────────────────────────────────────────────────────
// Gender / age screening (warn only)
// ─────────────────────────────────────────────────────────────────────────────

// UNICODE-AWARE BOUNDARIES ON PURPOSE. `\b` and `\w` in JavaScript are ASCII-only: `/\bженщины\b/`
// matches NOTHING in a Russian sentence, so the whole screening silently found zero phrases (the
// tests caught exactly that). `(?<![\p{L}])` / `(?![\p{L}])` under /u are the real "not inside
// another word" guards, in any alphabet.
const GENDER_RE: RegExp[] = [
  /(?<![\p{L}])только\s+(?:мужчин\p{L}*|женщин\p{L}*|парн\p{L}*|девуш\p{L}*)/giu,
  /(?<![\p{L}])(?:мужчины|мужчин|женщины|женщин|девушки|девушек|парни|парней)(?![\p{L}])/giu,
  /(?<![\p{L}])(?:men|women|male|female)\s+only(?![\p{L}])/giu,
];

const AGE_RE: RegExp[] = [
  /(?<![\p{L}])до\s+\d{1,2}\s*лет(?![\p{L}])/giu,
  /(?<![\p{L}])от\s+\d{1,2}\s*(?:до\s+\d{1,2}\s*)?лет(?![\p{L}])/giu,
  /\d{1,2}\s*[-–—]\s*\d{1,2}\s*лет(?![\p{L}])/giu,
  /(?<![\p{L}])возраст\p{L}*\s*[:\-–]?\s*(?:до|от)?\s*\d{1,2}/giu,
  /(?<![\p{L}])age\s*[:\-]?\s*\d{1,2}(?![\p{L}])/giu,
];

/**
 * Phrases in the owner's own text that limit the audience by GENDER or AGE. In Korea that is
 * forbidden in a hiring ad, so the preview warns about it — but publishing is NOT blocked: the
 * owner may be posting something that is not a job offer at all, and he is the one who decides.
 * Returns the matched fragments, de-duplicated, at most a handful.
 */
export function findDiscriminationHints(text: string): string[] {
  const found = new Set<string>();
  for (const re of [...GENDER_RE, ...AGE_RE]) {
    // Fresh lastIndex per call: the module-level regexes carry /g.
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const hit = m[0].trim().replace(/\s+/g, ' ');
      if (hit) found.add(hit.toLowerCase());
      if (found.size >= 6) return [...found];
    }
  }
  return [...found];
}

// ─────────────────────────────────────────────────────────────────────────────
// The command itself
// ─────────────────────────────────────────────────────────────────────────────

/** The copy-paste template printed by a bare `/post`. */
export const POST_TEMPLATE =
  'Отложенная публикация. Пришли ОДНИМ сообщением (текстом или подписью к фото):\n\n' +
  '/post\n' +
  'когда: завтра 09:00\n' +
  'повтор: нет\n' +
  'тип: обычное\n' +
  'город: Ансан\n' +
  'работа: завод\n' +
  'контакт: @nickname\n' +
  'уведомить: да\n' +
  '---\n' +
  'Заголовок объявления\n' +
  'Текст объявления.\n\n' +
  'Обязательны только «когда» и текст после ---. Остальное можно не писать.\n' +
  'Время — по Сеулу. Можно: «через 2 часа», «завтра 09:00», «02.08 09:00», «2026-08-02 09:00».\n' +
  'Повтор: «каждые 24 часа, 5 раз». При повторе прошлая публикация снимается — дубли в ленте не копятся.\n' +
  'Тип: «обычное» — как обычная вакансия. «реклама» — платное размещение: помечается словом «Реклама», ' +
  'показывается только в ленте и никому не уходит в личку.\n' +
  'Уведомить: «да» — подписчикам с подходящими фильтрами придёт уведомление (у рекламы — никогда).\n\n' +
  'Список запланированного: /posts';

/** The body of the command = everything after the first token (same rule as /broadcast). */
export function postBody(text: string): string {
  const firstToken = text.split(/\s+/, 1)[0] ?? '';
  return text.slice(firstToken.length).trim();
}

const KEY_ALIASES: Record<string, string> = {
  когда: 'when',
  when: 'when',
  повтор: 'repeat',
  repeat: 'repeat',
  тип: 'kind',
  type: 'kind',
  город: 'city',
  city: 'city',
  работа: 'work',
  work: 'work',
  контакт: 'contact',
  contact: 'contact',
  уведомить: 'notify',
  notify: 'notify',
};

const KNOWN_KEYS = 'когда, повтор, тип, город, работа, контакт, уведомить';

const YES = /^(да|yes|true|1|вкл)$/i;
const NO = /^(нет|no|false|0|выкл)$/i;

/**
 * Parse one /post BODY (the command word already stripped) into a validated plan.
 * `now` is injected so the whole thing is deterministic in tests.
 */
export function parsePostCommand(body: string, now: Date): PostParseResult {
  const raw = body.trim();
  if (!raw) return { ok: false, error: POST_TEMPLATE };

  const lines = raw.split('\n');
  const sep = lines.findIndex((l) => /^\s*-{3,}\s*$/.test(l));
  if (sep === -1) {
    return {
      ok: false,
      error: 'Не вижу разделителя «---». Над ним — параметры, под ним — текст объявления.\n\n' + POST_TEMPLATE,
    };
  }

  // ── head: параметры ──────────────────────────────────────────────────────
  const params = new Map<string, string>();
  for (const line of lines.slice(0, sep)) {
    const t = line.trim();
    if (!t) continue;
    const m = /^([A-Za-zА-Яа-яЁё_]+)\s*:\s*(.*)$/.exec(t);
    if (!m) {
      return { ok: false, error: `Строка «${t.slice(0, 60)}» не похожа на параметр. Формат: «ключ: значение».` };
    }
    const key = KEY_ALIASES[(m[1] ?? '').toLowerCase().replace(/ё/g, 'е')];
    if (!key) {
      return { ok: false, error: `Не знаю параметр «${m[1]}». Можно: ${KNOWN_KEYS}.` };
    }
    params.set(key, (m[2] ?? '').trim());
  }

  // ── tail: текст объявления ───────────────────────────────────────────────
  const text = lines.slice(sep + 1).join('\n').trim();
  if (!text) return { ok: false, error: 'После «---» пусто — не вижу текста объявления.' };
  if (text.length > DESCRIPTION_MAX) {
    return { ok: false, error: `Текст длиннее ${DESCRIPTION_MAX} символов — не влезет в карточку.` };
  }

  // ── когда ────────────────────────────────────────────────────────────────
  const whenRaw = params.get('when') ?? '';
  if (!whenRaw) {
    return { ok: false, error: 'Не хватает «когда». Например: «когда: завтра 09:00».' };
  }
  const startAt = parseWhen(whenRaw, now);
  if (!startAt) {
    return {
      ok: false,
      error:
        `Не понял «когда: ${whenRaw}». Можно так: «через 2 часа», «завтра 09:00», ` +
        '«02.08 09:00», «2026-08-02 09:00». Время по Сеулу.',
    };
  }
  // A minute of slack: «сейчас» and a just-passed round hour must not be refused on a rounding edge.
  if (startAt.getTime() < now.getTime() - 60_000) {
    return { ok: false, error: `Это время уже прошло (${formatSeoul(startAt)}, Сеул). Поставь будущее.` };
  }
  if (startAt.getTime() - now.getTime() > MAX_HORIZON_MS) {
    return { ok: false, error: 'Слишком далеко — планируем максимум на год вперёд.' };
  }

  // ── повтор ───────────────────────────────────────────────────────────────
  const rep = parseRepeat(params.get('repeat') ?? '');
  if (!rep.ok) return { ok: false, error: rep.error };

  // ── тип ──────────────────────────────────────────────────────────────────
  const kindRaw = (params.get('kind') ?? '').toLowerCase().replace(/ё/g, 'е');
  let kind: PostKind = 'ad';
  if (kindRaw) {
    // `[а-яё]*` again — `\w` does not cover Cyrillic, so «обычное» would fall through to the error.
    if (/^(обычн[а-яё]*|вакансия|ad)$/.test(kindRaw)) kind = 'ad';
    else if (/^(реклам[а-яё]*|платн[а-яё]*|promo|ad-promo)$/.test(kindRaw)) kind = 'promo';
    else {
      return { ok: false, error: 'Тип бывает «обычное» или «реклама».' };
    }
  }

  // ── работа ───────────────────────────────────────────────────────────────
  const workRaw = params.get('work') ?? '';
  let workType = 'other';
  if (workRaw) {
    const resolved = parseWorkType(workRaw);
    if (!resolved) {
      return {
        ok: false,
        error: `Не знаю работу «${workRaw}». Можно: завод, стройка, поле, рыбзавод, пищёвка, склад, общепит, уборка, уход, отель, услуги, другое.`,
      };
    }
    workType = resolved;
  }

  // ── уведомить ────────────────────────────────────────────────────────────
  // Default: an ordinary post DOES notify matching subscribers (owner decision, 2026-08-01) —
  // it behaves like any other vacancy. A paid placement NEVER does, whatever was typed: that
  // ban is a product rule, not a preference, so it is applied here and re-checked at publish
  // time and once more in the notify worker.
  const notifyRaw = params.get('notify') ?? '';
  let notify = true;
  if (notifyRaw) {
    if (YES.test(notifyRaw)) notify = true;
    else if (NO.test(notifyRaw)) notify = false;
    else return { ok: false, error: 'Уведомить — «да» или «нет».' };
  }
  if (kind === 'promo') notify = false;

  // ── payload ──────────────────────────────────────────────────────────────
  // The FIRST line is the title (moderation/summary field); the description keeps the WHOLE text,
  // because the feed card renders the description and never the title — cutting the first line out
  // would silently drop it from the card.
  const firstLine = (text.split('\n')[0] ?? '').trim();
  const title = (firstLine || text).slice(0, TITLE_MAX);
  const description = kind === 'promo' ? promoDescription(text) : text;

  const contactRaw = (params.get('contact') ?? '').trim().slice(0, CONTACT_MAX) || null;
  const cityInput = (params.get('city') ?? '').trim().slice(0, 60) || null;

  return {
    ok: true,
    plan: {
      kind,
      payload: {
        title,
        description: description.slice(0, DESCRIPTION_MAX),
        contactRaw,
        contactKind: contactRaw ? guessContactKind(contactRaw) : null,
        workType,
        cityInput,
      },
      startAt,
      intervalMinutes: rep.repeat.intervalMinutes,
      totalRuns: rep.repeat.totalRuns,
      notify,
      warnings: findDiscriminationHints(text),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The preview
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The schedule in plain Russian — the sentence the owner reads before confirming.
 * «Опубликую 2 августа, 09:00 (Сеул) и потом ещё 4 раза каждые 24 часа.»
 */
export function scheduleSentence(startAt: Date, intervalMinutes: number | null, totalRuns: number): string {
  const head = `Опубликую ${formatSeoul(startAt)} (Сеул)`;
  if (!intervalMinutes || totalRuns <= 1) return `${head}, один раз.`;
  const more = totalRuns - 1;
  return `${head} и потом ещё ${more} ${plural(more, 'раз', 'раза', 'раз')} ${humanInterval(intervalMinutes)}.`;
}

export interface PreviewContext {
  /** Human city label resolved against the directory, or the free text the owner typed. */
  cityLabel: string | null;
  /** true when the owner attached a photo and we stored it. */
  hasPhoto: boolean;
}

/**
 * How much of the ad text the preview quotes. A description may be 4000 characters and the rest of
 * the preview adds a few hundred more, while Bot API sendMessage refuses anything over 4096 — an
 * over-long preview would fail to send and the owner would see NOTHING (the draft would be
 * orphaned). So the quoted text is clipped here, and the clipping is stated in words.
 */
export const PREVIEW_BODY_MAX = 2800;

/**
 * The confirmation screen. Everything that will happen is spelled out in words — the schedule,
 * whether subscribers get a DM, what the type means, and (for a repeat) that the previous
 * publication is taken down rather than re-dated.
 */
export function previewText(plan: PostPlan, ctx: PreviewContext): string {
  const lines: string[] = ['Проверь, как это уйдёт в ленту:', ''];
  const body = plan.payload.description;
  const clipped = body.length > PREVIEW_BODY_MAX;
  lines.push(clipped ? `${body.slice(0, PREVIEW_BODY_MAX)}…` : body);
  if (clipped) lines.push('(текст показан не целиком — опубликуется полностью)');
  lines.push('');
  lines.push(scheduleSentence(plan.startAt, plan.intervalMinutes, plan.totalRuns));
  lines.push(
    plan.kind === 'promo'
      ? 'Тип: реклама — карточка помечена словом «Реклама», показывается только в ленте, в личку не уходит никому.'
      : 'Тип: обычное — как обычная вакансия в ленте.',
  );
  lines.push(
    plan.kind === 'promo'
      ? 'Уведомление подписчикам: нет (у рекламы — никогда).'
      : `Уведомление подписчикам: ${plan.notify ? 'да, по их фильтрам' : 'нет'}.`,
  );
  lines.push(`Фото: ${ctx.hasPhoto ? 'есть' : 'нет'}.`);
  lines.push(`Город: ${ctx.cityLabel ?? 'не указан'}.`);
  lines.push(`Работа: ${plan.payload.workType}.`);
  lines.push(`Контакт: ${plan.payload.contactRaw ?? 'не указан'}.`);
  if (plan.intervalMinutes && plan.totalRuns > 1) {
    lines.push('');
    lines.push(
      'Про повтор: каждая следующая публикация — НОВАЯ карточка, а прошлая в этот момент снимается. ' +
        'Дату мы не подменяем и старую карточку наверх не поднимаем.',
    );
  }
  if (plan.warnings.length > 0) {
    lines.push('');
    lines.push(
      `⚠️ В тексте есть ограничение по полу или возрасту (${plan.warnings.join(', ')}). ` +
        'В Корее так писать в объявлениях о работе нельзя. Публиковать не запрещаю — решай сам.',
    );
  }
  return lines.join('\n');
}

/** One line of /posts: what it is, when it fires next, how much is left. */
export function scheduleLine(row: {
  kind: string;
  status: string;
  title: string | null;
  nextRunAt: Date | null;
  doneRuns: number;
  totalRuns: number;
}): string {
  const kindLabel = row.kind === 'promo' ? 'Реклама' : 'Обычное';
  const head = `${kindLabel} · «${(row.title ?? '').slice(0, 60)}»`;
  const when =
    row.status === 'active' && row.nextRunAt
      ? `Следующая публикация: ${formatSeoul(row.nextRunAt)} (Сеул)`
      : `Статус: ${statusLabel(row.status)}`;
  return `${head}\n${when}\nОпубликовано: ${row.doneRuns} из ${row.totalRuns}`;
}

/** Statuses in words (the owner never reads English service tokens). */
export function statusLabel(status: string): string {
  switch (status) {
    case 'draft':
      return 'ждёт подтверждения';
    case 'active':
      return 'запланировано';
    case 'done':
      return 'всё опубликовано';
    case 'cancelled':
      return 'отменено';
    case 'failed':
      return 'сорвалось, смотри ошибку';
    default:
      return status;
  }
}

export interface PostCallback {
  action: 'ok' | 'cancel';
  id: string;
}

const POST_CB_RE = /^sp:(ok|cancel):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Parse an `sp:ok:<uuid>` / `sp:cancel:<uuid>` callback, or null when it is not one. */
export function parsePostCallback(data: string): PostCallback | null {
  const m = POST_CB_RE.exec(data);
  if (!m) return null;
  return { action: m[1]!.toLowerCase() as 'ok' | 'cancel', id: m[2]! };
}
