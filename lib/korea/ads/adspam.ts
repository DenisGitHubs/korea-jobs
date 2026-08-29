// lib/korea/ads/adspam.ts
//
// Deterministic anti-advertising backstop for USER-submitted ads ("Разместить"), run BEFORE
// the AI moderator. Owner rule ("не пропускать рекламу") + 007 rec: unlike the raw parser
// stream (parser/run.ts SPAM_PATTERNS), user ads had no deterministic guard — a confident
// promo could slip past a soft AI verdict. A match here rejects the ad outright (reject_reason
// 'ads') and spends no model tokens.
//
// PRECISION FIRST. A false positive rejects a legitimate job, so every pattern targets promo
// vocabulary that a real Korea manual-labour ad never uses. Words that ARE legitimate on a
// vacancy — работа / зарплата / вахта / оплата, and the wage sense of "ставка", and caregiving
// "интимная гигиена" — are deliberately NOT matched (see notes on the betting/adult rows).
//
// CYRILLIC BOUNDARY (durable lesson, same as parser/run.ts): JS \b and \w are ASCII-only, so a
// \b placed before a Cyrillic letter never matches and \w never spans а-я. We therefore use an
// explicit left boundary group (^|[^а-яёa-z0-9]) with the /iu flags, and [а-яё]* (never \w*)
// for Cyrillic word tails. The /i flag makes the boundary class case-insensitive, so a leading
// uppercase letter is still treated as "inside a word" (no match mid-word).

// Left boundary: start-of-string OR a char that is not a Cyrillic/Latin letter or digit.
const B = '(^|[^а-яёa-z0-9])';
// Right boundary (cyrillic-safe): end-of-string OR a non-letter/digit char (lookahead, zero-width).
// Same convention as parser/spamfilter.ts — needed by tok() below; an ASCII \b would never match here.
const E = '(?![а-яёa-z0-9])';
// HORIZONTAL whitespace only — space/tab/NBSP, NEVER a line break (gate 2026-08-19). This file's input
// is the WORST case for a plain \s+: adModText (ads/input.ts) joins SIX form fields with "\n", and
// "housing terms" and "meals" sit next to each other — so "Жильё: комната в аренду⏎Карточка иностранца
// обязательна" (an ordinary ad naming the board's most common requirement, 외국인등록증) matched an
// "аренда карт" mule rule and was rejected. Worse, ads/manage.ts re-classifies on every EDIT and
// unarchive, so an already published ad would have died on its author's next edit.
const H = '[^\\S\\r\\n]+';
// The two nouns a money mule rents out — bank CARD or ACCOUNT, each with an explicit ending list and a
// Cyrillic-safe right boundary, so "картон / картридж / картофель / счётчик" can never fire. Mirrors
// parser/spamfilter.ts.
const ACCOUNT_N = '(?:карт(?:очк[а-яё]*|ами|ах|ам|ой|а|ы|у|е)?|сч[её]т(?:ами|ах|ам|ов|а|у|е)?)(?![а-яё])';
// Zero-width chars (ZWSP/ZWNJ/ZWJ/word-joiner/BOM) spliced INSIDE words to dodge the matcher. Stripped
// in looksLikeAdSpam below — same set and same reason as parser/spamfilter.ts. /g is for .replace()
// only, never .test() (stateful lastIndex).
const ZERO_WIDTH = /[​‌‍⁠﻿]/g;

/** Build a boundary-anchored, case-insensitive pattern from a core alternation. */
function re(core: string): RegExp {
  return new RegExp(`${B}(?:${core})`, 'iu');
}
/** Standalone token bounded on BOTH sides (cyrillic-safe) — for short stems like "дроп". */
function tok(core: string): RegExp {
  return new RegExp(`${B}(?:${core})${E}`, 'iu');
}

export const AD_SPAM_PATTERNS: RegExp[] = [
  // "Подпишись на канал" style channel promotion (NOT the neutral noun "подписка" alone).
  re('подпишись|подпишитесь|подписывайт[а-яё]*|подписка\\s+на\\s+(?:наш\\s+)?канал'),
  // Advertising itself.
  re('реклам[а-яё]*'),
  // Promo code.
  re('промокод[а-яё]*'),
  // Discounts.
  re('скидк[а-яё]*'),
  // Casino.
  re('казино|casino'),
  // Betting/bookmakers. NOTE: the bare wage sense "ставка"/"почасовая ставка" is legitimate on a
  // vacancy, so we require the betting phrasing ("ставки на спорт/матч/игру") or an explicit
  // bookmaker term/brand — never bare "ставки".
  re('букмекер[а-яё]*|ставк[аиуе][а-яё]*\\s+на\\s+(?:спорт|матч|игр[а-яё]*)|бетт?инг|betting|1xbet|1хбет|фонбет|бетбум'),
  // Crypto / investment bait.
  re('крипт[оауеы][а-яё]*|криптовалют[а-яё]*|инвестици[а-яё]*|инвестиру[а-яё]*|биткоин|bitcoin'),
  // "Заработок в интернете / онлайн" — requires the online qualifier so the plain vacancy word
  // "заработок" (earnings) does not fire.
  re('зараб[оа]ток\\s+(?:в\\s+интернет[а-яё]*|онлайн)|доход\\s+в\\s+интернет[а-яё]*'),
  // Passive income.
  re('пассивн[а-яё]*\\s+доход[а-яё]*'),
  // Giveaways / follower boosting.
  re('розыгрыш[а-яё]*|разыгрыва[а-яё]*|гивэвей|гивевей|giveaway'),
  re('накрутк[а-яё]*'),
  // Adult. NOTE: bare "интим" is avoided — caregiving jobs legitimately mention "интимная
  // гигиена". We match escort / "интим-услуги" / "секс-услуги" / webcam / "18+" instead.
  re('эскорт[а-яё]*|18\\s*\\+|секс[-\\s]?услуг[а-яё]*|интим[-\\s]?услуг[а-яё]*|вебкам[а-яё]*|webcam'),

  // --- CRIMINAL HIRING / money mules (ported 2026-08-19 from parser/spamfilter.ts, where this class
  // has existed since the first block — but ONLY there. A recruiter who types the same text straight
  // into the "Разместить" form met NO deterministic rule here: this file knew casino, crypto and
  // adult, and nothing at all about обнал / дропы / аренда карт. Worse, the AI moderator alone does
  // not close it — a mule recruiter genuinely IS "an employer looking for workers", so the model can
  // read it as a vacancy (that is why prompt.ts now carries reject_reason=criminal_hiring too).
  // THESE SIX PATTERNS are a copy of the parser's money-mule rules (parser/spamfilter.ts) — edit one,
  // edit the other. The FILES are NOT twins and must not be described as such: the parser adds
  // structural heuristics this file has no equivalent of (emoji carpet, mixed script, ruble pay,
  // housing, seeker intro) and lowercases its input. What IS aligned as of 2026-08-19 is the input
  // normalization these patterns depend on — the zero-width strip in looksLikeAdSpam below. Before it,
  // one invisible character ("об⁠нал") passed this filter while the parser caught it.
  // 0-FP reasoning is the parser's: no legitimate Korea job ad uses this vocabulary.
  re('обнал[а-яё]*'),
  tok('дроп(?:овод[а-яё]*|[а-яё]{0,3})'),
  re(`аренд[а-яё]*${H}(?:банковск[а-яё]*${H})?${ACCOUNT_N}|${ACCOUNT_N}${H}(?:в|под)${H}аренду`),
  re(`перестановк[а-яё]*${H}средств`),
  re(`доплат[а-яё]*${H}за${H}(?:usdt|крипт)`),
];

/** True when the text carries explicit advertising/spam that a real job ad never would. */
export function looksLikeAdSpam(text: string | null | undefined): boolean {
  if (!text) return false;
  // Strip zero-width chars FIRST (gate 2026-08-19), exactly as looksLikeSpam does. Without it this
  // filter judged the RAW string while the parser judged a cleaned one, and a single invisible
  // character inside a word ("об⁠нал") walked past the form while the feed side caught it. Patterns
  // are /i, so no lowercasing is needed here. No /g on them → .test() is stateless and the
  // module-level array is safe to reuse.
  return AD_SPAM_PATTERNS.some((rx) => rx.test(text.replace(ZERO_WIDTH, '')));
}
