// lib/korea/scheduled/parse.test.ts
//
// The /post command: what the owner may type, what we refuse to guess, and what the preview
// promises him. Pure functions only — no DB, no Bot API, an injected clock.
//
// The rules pinned here are PRODUCT rules, not implementation details:
//   * a paid placement carries the word «Реклама» IN THE TEXT and never notifies anybody;
//   * a repeat is described honestly (new card, previous one taken down — no re-dating);
//   * a text limiting the audience by gender/age is WARNED about, never silently published;
//   * times are Asia/Seoul in the conversation, UTC in storage.

import { describe, it, expect } from 'vitest';
import {
  parsePostCommand,
  parseWhen,
  parseRepeat,
  parseWorkType,
  guessContactKind,
  findDiscriminationHints,
  previewText,
  scheduleSentence,
  scheduleLine,
  statusLabel,
  parsePostCallback,
  promoDescription,
  formatSeoul,
  humanInterval,
  plural,
  postBody,
  seoulParts,
  fromSeoul,
  POST_TEMPLATE,
  PROMO_DISCLAIMER,
  PROMO_VERIFY_NOTE,
  PREVIEW_BODY_MAX,
  DESCRIPTION_MAX,
  MAX_TOTAL_RUNS,
  MIN_INTERVAL_MINUTES,
} from './parse.js';

/** 2026-08-01 12:00 Asia/Seoul. */
const NOW = new Date('2026-08-01T03:00:00.000Z');

const FULL = [
  'когда: завтра 09:00',
  'повтор: каждые 24 часа, 5 раз',
  'тип: обычное',
  'город: Ансан',
  'работа: завод',
  'контакт: @koreajobs',
  'уведомить: да',
  '---',
  'Нужны рабочие на завод',
  'Смена 12 часов, оплата раз в неделю.',
].join('\n');

function plan(body: string, now: Date = NOW) {
  const r = parsePostCommand(body, now);
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.plan;
}

function err(body: string, now: Date = NOW): string {
  const r = parsePostCommand(body, now);
  if (r.ok) throw new Error('expected an error, got a plan');
  return r.error;
}

// ─────────────────────────────────────────────────────────────────────────────
// The happy path
// ─────────────────────────────────────────────────────────────────────────────

describe('/post — a complete command', () => {
  it('reads every field and converts the time from Seoul to UTC', () => {
    const p = plan(FULL);
    expect(p.kind).toBe('ad');
    // «завтра 09:00» Seoul on 1 Aug -> 2 Aug 00:00 UTC (Seoul is UTC+9, no DST).
    expect(p.startAt.toISOString()).toBe('2026-08-02T00:00:00.000Z');
    expect(p.intervalMinutes).toBe(24 * 60);
    expect(p.totalRuns).toBe(5);
    expect(p.notify).toBe(true);
    expect(p.payload.workType).toBe('factory');
    expect(p.payload.cityInput).toBe('Ансан');
    expect(p.payload.contactRaw).toBe('@koreajobs');
    expect(p.payload.contactKind).toBe('telegram');
    // The title is the FIRST line; the description keeps the WHOLE text (the card renders the
    // description, so cutting the first line out would silently drop it).
    expect(p.payload.title).toBe('Нужны рабочие на завод');
    expect(p.payload.description).toContain('Нужны рабочие на завод');
    expect(p.payload.description).toContain('Смена 12 часов');
    expect(p.warnings).toEqual([]);
  });

  it('only «когда» and the text are required', () => {
    const p = plan('когда: через 2 часа\n---\nПростое объявление');
    expect(p.startAt.toISOString()).toBe('2026-08-01T05:00:00.000Z');
    expect(p.intervalMinutes).toBeNull();
    expect(p.totalRuns).toBe(1);
    expect(p.payload.workType).toBe('other');
    expect(p.payload.cityInput).toBeNull();
    expect(p.payload.contactRaw).toBeNull();
    // An ordinary post notifies matching subscribers by default (owner decision).
    expect(p.notify).toBe(true);
  });

  it('postBody strips the command word (and the /post@BotName form)', () => {
    expect(postBody('/post\nкогда: завтра 09:00')).toBe('когда: завтра 09:00');
    expect(postBody('/post@korea_rabota_bot когда: сейчас')).toBe('когда: сейчас');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PAID PLACEMENT — the legal core
// ─────────────────────────────────────────────────────────────────────────────

describe('/post — «тип: реклама»', () => {
  it('labels the TEXT itself and never notifies, even when «уведомить: да»', () => {
    const p = plan(['когда: сегодня 18:00', 'тип: реклама', 'уведомить: да', '---', 'Курсы корейского'].join('\n'));
    expect(p.kind).toBe('promo');
    // The ban is a product rule, not a preference: it wins over what was typed.
    expect(p.notify).toBe(false);
    // The word «Реклама» rides ALONG WITH the text, so it survives a client that forgets the badge.
    expect(p.payload.description).toContain('Реклама.');
    expect(p.payload.description).toContain(PROMO_DISCLAIMER);
    expect(p.payload.description).toContain(PROMO_VERIFY_NOTE);
  });

  it('promoDescription appends the two published disclaimers verbatim', () => {
    expect(promoDescription('Текст')).toBe(`Текст\n\n${PROMO_DISCLAIMER}\n${PROMO_VERIFY_NOTE}`);
  });

  it('the preview says out loud that a promo goes nowhere near a DM', () => {
    const p = plan(['когда: сегодня 18:00', 'тип: реклама', '---', 'Курсы корейского'].join('\n'));
    const text = previewText(p, { cityLabel: null, hasPhoto: false });
    expect(text).toContain('только в ленте');
    expect(text).toContain('Уведомление подписчикам: нет');
  });

  it('an ordinary post is NOT dressed up as an ad', () => {
    const p = plan(FULL);
    expect(p.payload.description).not.toContain(PROMO_DISCLAIMER);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Broken / half-typed commands — each refusal must SAY what to type
// ─────────────────────────────────────────────────────────────────────────────

describe('/post — malformed input', () => {
  it('a bare /post answers with the template', () => {
    expect(err('')).toBe(POST_TEMPLATE);
  });

  it('no «---» separator', () => {
    expect(err('когда: завтра 09:00\nтекст без разделителя')).toContain('---');
  });

  it('nothing after the separator', () => {
    expect(err('когда: завтра 09:00\n---\n   ')).toContain('не вижу текста');
  });

  it('a head line that is not «ключ: значение»', () => {
    expect(err('завтра в девять\n---\nтекст')).toContain('не похожа на параметр');
  });

  it('an unknown parameter names itself and lists the known ones', () => {
    const e = err('когда: завтра 09:00\nцена: 100\n---\nтекст');
    expect(e).toContain('цена');
    expect(e).toContain('когда');
  });

  it('«когда» missing entirely', () => {
    expect(err('город: Ансан\n---\nтекст')).toContain('когда');
  });

  it('«когда» in a shape we refuse to guess', () => {
    expect(err('когда: как-нибудь потом\n---\nтекст')).toContain('Не понял «когда');
  });

  it('a time that already passed is refused (with the Seoul time spelled out)', () => {
    const e = err('когда: 2026-07-30 09:00\n---\nтекст');
    expect(e).toContain('уже прошло');
    expect(e).toContain('Сеул');
  });

  it('further than a year ahead', () => {
    expect(err('когда: 2030-01-01 09:00\n---\nтекст')).toContain('максимум на год');
  });

  it('an unknown «тип»', () => {
    expect(err('когда: сейчас\nтип: премиум\n---\nтекст')).toContain('«обычное» или «реклама»');
  });

  it('an unknown «работа» lists what is allowed', () => {
    const e = err('когда: сейчас\nработа: программист\n---\nтекст');
    expect(e).toContain('программист');
    expect(e).toContain('завод');
  });

  it('«уведомить» that is neither да nor нет', () => {
    expect(err('когда: сейчас\nуведомить: может быть\n---\nтекст')).toContain('«да» или «нет»');
  });

  it('a text longer than the card can hold', () => {
    expect(err(`когда: сейчас\n---\n${'а'.repeat(DESCRIPTION_MAX + 1)}`)).toContain('длиннее');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// «когда»
// ─────────────────────────────────────────────────────────────────────────────

describe('parseWhen', () => {
  it('«сейчас»', () => {
    expect(parseWhen('сейчас', NOW)!.toISOString()).toBe(NOW.toISOString());
  });

  it('relative offsets', () => {
    expect(parseWhen('через 30 минут', NOW)!.toISOString()).toBe('2026-08-01T03:30:00.000Z');
    expect(parseWhen('через 2 часа', NOW)!.toISOString()).toBe('2026-08-01T05:00:00.000Z');
    expect(parseWhen('через 3 дня', NOW)!.toISOString()).toBe('2026-08-04T03:00:00.000Z');
  });

  it('день + час', () => {
    expect(parseWhen('сегодня 18:00', NOW)!.toISOString()).toBe('2026-08-01T09:00:00.000Z');
    expect(parseWhen('завтра 09:00', NOW)!.toISOString()).toBe('2026-08-02T00:00:00.000Z');
    expect(parseWhen('послезавтра 09:00', NOW)!.toISOString()).toBe('2026-08-03T00:00:00.000Z');
  });

  it('dates in both shapes', () => {
    expect(parseWhen('02.08 09:00', NOW)!.toISOString()).toBe('2026-08-02T00:00:00.000Z');
    expect(parseWhen('02.08.2026 09:00', NOW)!.toISOString()).toBe('2026-08-02T00:00:00.000Z');
    expect(parseWhen('2026-08-02 09:00', NOW)!.toISOString()).toBe('2026-08-02T00:00:00.000Z');
  });

  it('a bare hour means today, or tomorrow once it is behind us', () => {
    // 12:00 Seoul now: 18:00 is still ahead, 09:00 is not.
    expect(parseWhen('18:00', NOW)!.toISOString()).toBe('2026-08-01T09:00:00.000Z');
    expect(parseWhen('09:00', NOW)!.toISOString()).toBe('2026-08-02T00:00:00.000Z');
  });

  it('a bare DD.MM that already passed rolls into next year', () => {
    expect(parseWhen('01.03 09:00', NOW)!.toISOString()).toBe('2027-03-01T00:00:00.000Z');
  });

  it('refuses nonsense instead of guessing', () => {
    expect(parseWhen('', NOW)).toBeNull();
    expect(parseWhen('завтра', NOW)).toBeNull(); // a day with no hour is ambiguous
    expect(parseWhen('25:00', NOW)).toBeNull();
    expect(parseWhen('через много часов', NOW)).toBeNull();
    expect(parseWhen('40.13 09:00', NOW)).toBeNull();
  });

  it('the Seoul wall clock round-trips', () => {
    const p = seoulParts(NOW);
    expect([p.y, p.m, p.d, p.hh]).toEqual([2026, 8, 1, 12]);
    expect(fromSeoul(p.y, p.m, p.d, p.hh, p.mm).toISOString()).toBe(NOW.toISOString());
    expect(formatSeoul(NOW)).toBe('1 августа, 12:00');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// «повтор»
// ─────────────────────────────────────────────────────────────────────────────

describe('parseRepeat', () => {
  it('no repeat by default and by word', () => {
    for (const s of ['', 'нет', 'один раз', 'однократно']) {
      const r = parseRepeat(s);
      expect(r.ok && r.repeat).toEqual({ intervalMinutes: null, totalRuns: 1 });
    }
  });

  it('«каждые 24 часа, 5 раз» / «каждый день, 3 раза»', () => {
    const a = parseRepeat('каждые 24 часа, 5 раз');
    expect(a.ok && a.repeat).toEqual({ intervalMinutes: 1440, totalRuns: 5 });
    const b = parseRepeat('каждый день, 3 раза');
    expect(b.ok && b.repeat).toEqual({ intervalMinutes: 1440, totalRuns: 3 });
  });

  it('refuses a flood, an endless repeat and a silly count', () => {
    const tooOften = parseRepeat('каждые 2 минуты, 5 раз');
    expect(tooOften.ok).toBe(false);
    expect(!tooOften.ok && tooOften.error).toContain(String(MIN_INTERVAL_MINUTES));

    const noCount = parseRepeat('каждые 24 часа');
    expect(noCount.ok).toBe(false);
    expect(!noCount.ok && noCount.error).toContain('Сколько раз');

    const once = parseRepeat('каждые 24 часа, 1 раз');
    expect(once.ok).toBe(false);

    const tooMany = parseRepeat(`каждые 24 часа, ${MAX_TOTAL_RUNS + 1} раз`);
    expect(tooMany.ok).toBe(false);
    expect(!tooMany.ok && tooMany.error).toContain(String(MAX_TOTAL_RUNS));

    const nonsense = parseRepeat('иногда');
    expect(nonsense.ok).toBe(false);
  });

  it('humanInterval speaks Russian', () => {
    expect(humanInterval(1440)).toBe('каждый день');
    expect(humanInterval(2880)).toBe('каждые 2 дня');
    expect(humanInterval(60)).toBe('каждый час');
    expect(humanInterval(180)).toBe('каждые 3 часа');
    expect(humanInterval(90)).toBe('каждые 90 минут');
    expect(plural(1, 'раз', 'раза', 'раз')).toBe('раз');
    expect(plural(2, 'раз', 'раза', 'раз')).toBe('раза');
    expect(plural(11, 'раз', 'раза', 'раз')).toBe('раз');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Work type / contact
// ─────────────────────────────────────────────────────────────────────────────

describe('parseWorkType / guessContactKind', () => {
  it('maps the words the owner actually types', () => {
    expect(parseWorkType('завод')).toBe('factory');
    expect(parseWorkType('Стройка')).toBe('construction');
    expect(parseWorkType('пищёвка')).toBe('food');
    expect(parseWorkType('поле, ферма')).toBe('agriculture');
    expect(parseWorkType('склад (ночь)')).toBe('logistics');
    expect(parseWorkType('балет')).toBeNull();
  });

  it('guesses the contact channel', () => {
    expect(guessContactKind('@koreajobs')).toBe('telegram');
    expect(guessContactKind('https://t.me/koreajobs')).toBe('telegram');
    expect(guessContactKind('+82 10 1234 5678')).toBe('phone');
    expect(guessContactKind('kakao: koreajobs')).toBe('kakao');
    expect(guessContactKind('приходите в офис')).toBe('other');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gender / age — warn, never block
// ─────────────────────────────────────────────────────────────────────────────

describe('gender/age screening', () => {
  it('finds the phrases Korea forbids in a hiring ad', () => {
    expect(findDiscriminationHints('Только женщины, до 35 лет').length).toBeGreaterThan(0);
    expect(findDiscriminationHints('нужны мужчины от 20 до 45 лет').length).toBeGreaterThan(0);
    expect(findDiscriminationHints('women only, age 25').length).toBeGreaterThan(0);
  });

  it('says nothing about an ordinary text', () => {
    expect(findDiscriminationHints('Нужны рабочие на завод, оплата раз в неделю')).toEqual([]);
  });

  it('the preview warns but the plan is still valid (the owner decides)', () => {
    const p = plan('когда: сейчас\n---\nНа завод\nТолько женщины до 35 лет');
    expect(p.warnings.length).toBeGreaterThan(0);
    const text = previewText(p, { cityLabel: 'Ансан', hasPhoto: false });
    expect(text).toContain('⚠️');
    expect(text).toContain('по полу или возрасту');
    expect(text).toContain('решай сам');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The preview the owner confirms
// ─────────────────────────────────────────────────────────────────────────────

describe('previewText', () => {
  it('spells out the schedule, the type, the DM policy, the photo and the city', () => {
    const p = plan(FULL);
    const text = previewText(p, { cityLabel: 'Ансан', hasPhoto: true });
    expect(text).toContain('Опубликую 2 августа, 09:00 (Сеул)');
    expect(text).toContain('ещё 4 раза каждый день');
    expect(text).toContain('Тип: обычное');
    expect(text).toContain('Уведомление подписчикам: да');
    expect(text).toContain('Фото: есть');
    expect(text).toContain('Город: Ансан');
    expect(text).toContain('Контакт: @koreajobs');
  });

  it('warns that a REPEAT publishes anew and takes the previous card down', () => {
    const text = previewText(plan(FULL), { cityLabel: null, hasPhoto: false });
    expect(text).toContain('НОВАЯ карточка');
    expect(text).toContain('прошлая в этот момент снимается');
    expect(text).toContain('наверх не поднимаем');
  });

  it('a single publication gets no repeat paragraph', () => {
    const text = previewText(plan('когда: сейчас\n---\nтекст'), { cityLabel: null, hasPhoto: false });
    expect(text).toContain('один раз');
    expect(text).not.toContain('НОВАЯ карточка');
  });

  it('clips a very long text so the preview can actually be sent (Bot API 4096)', () => {
    const p = plan(`когда: сейчас\n---\n${'я'.repeat(DESCRIPTION_MAX)}`);
    const text = previewText(p, { cityLabel: null, hasPhoto: false });
    expect(text.length).toBeLessThan(4096);
    expect(text).toContain('не целиком');
    expect(PREVIEW_BODY_MAX).toBeLessThan(DESCRIPTION_MAX);
  });

  it('scheduleSentence covers both shapes', () => {
    const at = new Date('2026-08-02T00:00:00.000Z');
    expect(scheduleSentence(at, null, 1)).toBe('Опубликую 2 августа, 09:00 (Сеул), один раз.');
    expect(scheduleSentence(at, 1440, 3)).toContain('и потом ещё 2 раза каждый день');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /posts lines + the inline callbacks
// ─────────────────────────────────────────────────────────────────────────────

describe('/posts lines', () => {
  it('an active schedule shows its next moment', () => {
    const line = scheduleLine({
      kind: 'ad',
      status: 'active',
      title: 'Завод в Ансане',
      nextRunAt: new Date('2026-08-02T00:00:00.000Z'),
      doneRuns: 1,
      totalRuns: 5,
    });
    expect(line).toContain('Обычное · «Завод в Ансане»');
    expect(line).toContain('Следующая публикация: 2 августа, 09:00 (Сеул)');
    expect(line).toContain('Опубликовано: 1 из 5');
  });

  it('a finished/cancelled schedule shows a human status instead', () => {
    const line = scheduleLine({
      kind: 'promo',
      status: 'cancelled',
      title: 'Курсы',
      nextRunAt: null,
      doneRuns: 0,
      totalRuns: 1,
    });
    expect(line).toContain('Реклама · «Курсы»');
    expect(line).toContain('отменено');
    expect(statusLabel('failed')).toContain('сорвалось');
    expect(statusLabel('done')).toBe('всё опубликовано');
  });
});

describe('parsePostCallback', () => {
  const id = '0f8c2a1b-3d4e-4f5a-6b7c-8d9e0f1a2b3c';
  it('accepts our own two buttons', () => {
    expect(parsePostCallback(`sp:ok:${id}`)).toEqual({ action: 'ok', id });
    expect(parsePostCallback(`sp:cancel:${id}`)).toEqual({ action: 'cancel', id });
  });
  it('rejects anything else (no partial matching, no non-uuid)', () => {
    expect(parsePostCallback('bc:send:' + id)).toBeNull();
    expect(parsePostCallback('sp:ok:not-a-uuid')).toBeNull();
    expect(parsePostCallback(`sp:delete:${id}`)).toBeNull();
    expect(parsePostCallback(`prefix sp:ok:${id}`)).toBeNull();
  });
});
