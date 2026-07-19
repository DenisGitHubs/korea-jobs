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

/** Build a boundary-anchored, case-insensitive pattern from a core alternation. */
function re(core: string): RegExp {
  return new RegExp(`${B}(?:${core})`, 'iu');
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
];

/** True when the text carries explicit advertising/spam that a real job ad never would. */
export function looksLikeAdSpam(text: string | null | undefined): boolean {
  if (!text) return false;
  // No /g flag on the patterns, so .test() is stateless — safe to reuse the module-level array.
  return AD_SPAM_PATTERNS.some((rx) => rx.test(text));
}
