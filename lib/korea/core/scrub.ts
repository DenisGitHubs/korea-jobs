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
// Generic long digit run (the former rule #7 catch-all pattern), now applied via a callback.
const RE_GENERIC_PHONE = /\+?\d[\d\s().\-]{7,}\d/g;

// True when a long digit run reads as money (a unit follows, or a pay marker precedes it).
function isMoneyRun(match: string, offset: number, full: string): boolean {
  const after = full.slice(offset + match.length, offset + match.length + 32);
  const before = full.slice(Math.max(0, offset - 24), offset);
  return RE_MONEY_AFTER.test(after) || RE_MONEY_BEFORE.test(before);
}

/**
 * Strip obvious contacts (chat links, e-mails, @handles, "<messenger> <id>", phones) from
 * free text. Heuristic and surgical: only contact-shaped constructs are redacted; ordinary
 * prose (including a messenger word followed by a Cyrillic word) is left intact.
 */
export function scrubContacts(text: string | null): string | null {
  if (!text) return text;
  return (
    text
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
      })
  );
}
