// lib/korea/core/scrub.ts
//
// Shared contact scrubber: strip obvious contacts from free text, replacing each with a
// redaction marker. Used on BOTH the write side (parser: the full-text description stored on
// a vacancy) and the read side (feed/detail projection, and the /api/raw "not sorted yet"
// stream) as defense in depth. Single source of truth so the surfaces can never drift.
//
// This is HEURISTIC, not a proof: it catches the common shapes (links, e-mails, @handles,
// "<messenger> <id>", phones), but an oddly formatted contact can still slip through. Treat
// it as defense-in-depth, never as a guarantee. Order matters (see below).

const REDACT = '[скрыто]';

// Messenger app names (RU / EN / KO). A recruitment post often gives a contact as
// "<app> <id>" with NO leading @, which the @handle rule cannot see — so we redact the id /
// number that follows one of these words. Longer names first so the alternation is greedy
// (kakaotalk before kakao). Deliberately NOT included: Russian "каток"-like transliterations,
// which collide with the ordinary word "каток" (skating rink) and would burn normal prose.
const MESSENGER =
  'kakaotalk|kakao|카카오톡|카톡|telegram|телеграмм|телеграм|телега|whatsapp|whats\\s?app|ватсап|вотсап|вацап|viber|вайбер|line|лайн|tg';

// The id/handle token that follows a messenger word: LATIN only, so plain Cyrillic prose
// after the word (e.g. "телеграм канал") is NOT eaten; must start with @ or an alnum/_.
const MSG_ID = '@?[A-Za-z0-9_][A-Za-z0-9._+-]{1,30}';

// Phone-label words (RU / EN / KO): a number right after one of these is a phone even when
// it is short or oddly grouped, i.e. below the generic detector's length bar.
const PHONE_WORD = 'telephone|tel|phone|тел(?:ефон)?|моб(?:ильный)?|hp|번호|전화|핸드폰|휴대폰|폰';

// Not preceded by a letter/number (Unicode-aware), so a keyword/label is a standalone token
// and we don't fire inside words ("online" -> "line", "онлайн" -> "лайн", "mtg" -> "tg").
const LB = '(?<![\\p{L}\\p{N}])';

// Built once (module load), not per call.
const RE_MSG_ID_MARKER = new RegExp(`${LB}(${MESSENGER})\\s*(?:id|айди)\\s*[:：#№.\\-—]*\\s*${MSG_ID}`, 'giu');
const RE_MSG_SEP = new RegExp(`${LB}(${MESSENGER})[\\s:：#№.\\-—]+${MSG_ID}`, 'giu');
const RE_PHONE_LABELLED = new RegExp(`${LB}(?:${PHONE_WORD})\\.?\\s*[:：]?\\s*\\+?\\d[\\d\\s().\\-]{3,}\\d`, 'giu');

// --- Money vocabulary (rule #7 rescue only) --------------------------------------------------
// A long digit run is normally treated as a phone (rule #7). But salary posts carry big amounts
// ("2 500 000~3 000 000 вон", "월 2 500 000원") that are NOT contacts. We RESCUE such a run from
// redaction ONLY when it carries a clear money signal. This never weakens phone detection: a run
// that looks like a phone (leading '+' or a leading 0 — i.e. every Korean landline/mobile and
// every international number) is redacted BEFORE money context is consulted, and the default for
// anything ambiguous stays REDACT. So this can only keep amounts, never leak a number.

// Currency/unit token that sits right AFTER an amount.
const MONEY_UNIT =
  '원|만원|만|천원|천만원|억원|억|₩|krw|won|вон|рубл\\w*|руб\\w*|₽|달러|dollars?|\\$|유로|евро|eur|usd';

// Pay marker that sits right BEFORE an amount.
const SALARY_MARKER =
  '월급|시급|일급|주급|연봉|시간당|월|зарплат\\w*|оплат\\w*|в\\s*месяц|в\\s*час|в\\s*день|за\\s*час|за\\s*день|за\\s*месяц|per\\s*month|per\\s*hour|salary';

// Money unit right after the number, tolerating a range tail ("N~M원", "2 500 000 - 3 000 000 вон").
const RE_MONEY_AFTER = new RegExp(`^\\s*(?:[~\\-–—]\\s*[\\d\\s.,]*)?(?:${MONEY_UNIT})`, 'iu');
// Salary marker immediately before the number ("월 2 500 000", "зарплата 2500000").
const RE_MONEY_BEFORE = new RegExp(`(?:${SALARY_MARKER})[\\s:：]*$`, 'iu');
// A run immediately followed by '%' is a percentage / tax rate ("120.000 -3.3%", "수수료 3%"),
// never a phone (no phone carries a percent sign). Rescue it like money — but only after the
// phone-length guard in isMoneyRun (see there): phone-shaped runs (leading '+' or 0) are already
// gone before this is consulted, and an unformatted phone typed without either is refused there.
const RE_PERCENT_AFTER = /^\s*%/;

// --- Clock-time protection -------------------------------------------------------------------
// Real clock time (HH:MM): 1-2 hour digits, ':', EXACTLY 2 minute digits, bounded by non-digits
// on both sides. The `(?!\d)` tail is what makes it a REAL time and not the head of a phone:
// "15:00" / "9:00" match, but "9:01012345678" does NOT (its ":" is followed by a phone, not by a
// clean 2-digit minute). Real times are masked out before the generic phone pass and restored
// after, so that pass can neither eat a time nor start on a time's digits. This replaces the old,
// leaky `(?<!\d:\d?)` lookbehind, which blindly shielded 2 positions after ANY "digit:" — so a
// phone glued to a fake "9:" started on its 3rd digit and part of it survived.
const RE_CLOCK_TIME = /(?<!\d)\d{1,2}:\d{2}(?!\d)/g;

// Placeholder frame for a stashed time. Private-Use codepoints (U+E000/U+E001): not letters,
// digits, spaces or punctuation, so they appear in NO scrub pattern AND act as run boundaries —
// the framed index can never be swallowed by the generic phone pass. Built from char codes so the
// source stays pure ASCII (no invisible characters in the file).
const TOK_OPEN = String.fromCharCode(0xe000);
const TOK_CLOSE = String.fromCharCode(0xe001);
const RE_TIME_TOKEN = new RegExp(`${TOK_OPEN}(\\d+)${TOK_CLOSE}`, 'g');

// Generic long digit run (the former rule #7 catch-all pattern), applied via a callback. No time
// guard here: real clock times are already masked away (see RE_CLOCK_TIME) before this runs, so
// the run can only start on genuine, non-time digits.
const RE_GENERIC_PHONE = /\+?\d[\d\s().\-]{7,}\d/g;

// Longest run of consecutive digits inside a token. Tells a grouped money figure (many short
// groups, e.g. "12.000.000" -> 3) from an unformatted phone (one long run, e.g. "821012345678"
// -> 12). Used to keep the percent rescue from ever saving a phone.
function longestDigitRun(s: string): number {
  let max = 0;
  let cur = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 48 && c <= 57) {
      cur += 1;
      if (cur > max) max = cur;
    } else {
      cur = 0;
    }
  }
  return max;
}

// True when a long digit run reads as a NON-phone (a money unit follows, a pay marker precedes,
// or a percent sign follows). Only ever ADDS a "keep"; the default for anything ambiguous is REDACT.
function isMoneyRun(match: string, offset: number, full: string): boolean {
  const after = full.slice(offset + match.length, offset + match.length + 32);
  const before = full.slice(Math.max(0, offset - 24), offset);
  if (RE_MONEY_AFTER.test(after) || RE_MONEY_BEFORE.test(before)) return true;
  // Percent rescue is stricter than the money-unit/marker rescue: a run right before '%' is a
  // rate/amount ("120.000 -3.3%") — but ONLY when it is not phone-length. An international number
  // typed without '+' or a leading 0 ("821012345678%") is NOT phone-shaped and would otherwise be
  // saved by the bare '%'. We refuse the rescue for any run whose longest contiguous digit group
  // reaches phone length (>= 9). Grouped salary figures never do (max ~3), so this keeps
  // "120.000 -3.3%" / "12.000.000 -3.3%" whole while redacting the phone. Threshold 9 = the
  // shortest plausible phone (KR mobile is 10-11, +82 is 11-13), far above the 3-4 contiguous
  // digits of a grouped amount.
  if (RE_PERCENT_AFTER.test(after) && longestDigitRun(match) < 9) return true;
  return false;
}

/**
 * Strip obvious contacts (chat links, e-mails, @handles, "<messenger> <id>", phones) from
 * free text. Heuristic and surgical: only contact-shaped constructs are redacted; ordinary
 * prose (including a messenger word followed by a Cyrillic word) is left intact.
 */
export function scrubContacts(text: string | null): string | null {
  if (!text) return text;

  // Protect real clock times (HH:MM) up front: stash each into a Private-Use placeholder that
  // carries no colon and — framed by U+E000/U+E001 — no swallowable digits, so no later rule
  // (least of all the generic phone pass) can match inside or across it. Restored verbatim at the
  // very end. A fake "9:01012345678" is NOT a real time (RE_CLOCK_TIME), so it is left in place
  // and its phone tail is redacted normally.
  const times: string[] = [];
  const stashed = text.replace(RE_CLOCK_TIME, (m) => {
    const token = `${TOK_OPEN}${times.length}${TOK_CLOSE}`;
    times.push(m);
    return token;
  });

  const scrubbed = stashed
    // 1) Chat/profile links.
    .replace(/(?:https?:\/\/)?(?:t\.me|wa\.me|open\.kakao\.com|kakao\.com)\/\S+/gi, REDACT)
    // 2) E-mail — redact the WHOLE address. Must run before the @handle rule, which would
    //    otherwise only eat "@domain" and leave the local part + ".com" behind.
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, REDACT)
    // 3) Messenger word + explicit "id"/"айди" marker + handle ("kakao id: xxx"). Keeps the
    //    app word (so the card still reads "kakao [скрыто]") and redacts the id.
    .replace(RE_MSG_ID_MARKER, `$1 ${REDACT}`)
    // 4) Messenger word + separator + handle ("카톡 worker2025", "telegram: xxx", "line xxx").
    .replace(RE_MSG_SEP, `$1 ${REDACT}`)
    // 5) Bare @handles.
    .replace(/@[A-Za-z0-9_]{4,}/g, REDACT)
    // 6) Labelled phone — a number right after a phone word, even if short/oddly grouped.
    .replace(RE_PHONE_LABELLED, REDACT)
    // 7) Generic phone: a long run of digits/space/()-.  Formerly redacted EVERY such run,
    //    which also ate big salary amounts ("2 500 000~3 000 000 вон" -> "[скрыто]~[скрыто]").
    //    Now: still redact anything phone-shaped (leading '+' or a leading 0 — every Korean and
    //    international number; labelled numbers are already gone via #6), but KEEP a run that
    //    carries a clear money signal. Default is REDACT, so this only rescues amounts.
    .replace(RE_GENERIC_PHONE, (m: string, offset: number, full: string) => {
      const digits = m.replace(/\D/g, '');
      if (m.includes('+') || digits.startsWith('0')) return REDACT; // phone-shaped
      return isMoneyRun(m, offset, full) ? m : REDACT;
    });

  // Restore the stashed real clock times verbatim. The token only ever holds a valid index; the
  // `?? full` fallback keeps the replacer total (and satisfies noUncheckedIndexedAccess).
  return scrubbed.replace(RE_TIME_TOKEN, (full, i: string) => times[Number(i)] ?? full);
}
