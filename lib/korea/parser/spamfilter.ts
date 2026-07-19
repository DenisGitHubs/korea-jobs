// lib/korea/parser/spamfilter.ts
//
// Cheap, high-precision spam pre-filter for the raw parser stream, run BEFORE the AI call in
// parser/run.ts — obvious non-jobs (crypto exchange, money-mule, leaflet gigs, emoji carpets)
// are the bulk of the raw stream and must not burn model tokens. Extracted from run.ts so the
// rules are unit-testable in isolation (spamfilter.test.ts), mirroring ads/adspam.ts.
//
// CONSERVATIVE by design (precision >> recall): only near-certain spam matches; anything
// borderline still goes to the model. A false positive silently drops a real vacancy, so every
// pattern targets vocabulary a real Korea manual-labour ad never uses.
//
// CYRILLIC BOUNDARY (durable lesson, same as ads/adspam.ts): JS \b and \w are ASCII-only, so a
// \b placed before/after a Cyrillic letter never matches and \w never spans а-я. For Cyrillic we
// use an explicit boundary group (^|[^а-яёa-z0-9]) with the /iu flags and [а-яё]* (never \w*) for
// word tails. The /i flag makes the boundary class case-insensitive. Latin-only tokens keep the
// working ASCII \b. Patterns are matched against the LOWERCASED text (see looksLikeSpam).

// Left boundary: start-of-string OR a char that is not a Cyrillic/Latin letter or digit.
const B = '(^|[^а-яёa-z0-9])';
// Right boundary (cyrillic-safe): end-of-string OR a non-letter/digit char (lookahead, zero-width).
const E = '(?![а-яёa-z0-9])';

/** Boundary-anchored (left only), case-insensitive pattern from a core alternation. */
function re(core: string): RegExp {
  return new RegExp(`${B}(?:${core})`, 'iu');
}
/** Standalone token bounded on BOTH sides (cyrillic-safe) — for short latin tokens like btc/otc. */
function tok(core: string): RegExp {
  return new RegExp(`${B}(?:${core})${E}`, 'iu');
}

export const SPAM_PATTERNS: RegExp[] = [
  /\busdt\b|\busdc\b|bitcoin|биткоин/i,
  /крипт[оаыу]?\b|криптовалют|криптоактив|криптообмен/i,
  /обмен\s+(валют|usdt|usd|крипт|наличк|денег)/i,
  /перестановк\w*\s+средств/i,
  /inside\s*exchange|exchange\s*express|otc[- ]?сервис/i,
  /доплат\w*\s+за\s+(usdt|крипт)/i,
  /вон[ыа]?\s*(на|→|->)\s*рубл|рубл\w*\s*(на|→|->)\s*вон/i,
  /обнал\w+|\bдроп(ы|ов|ами)?\b|аренд\w*\s+карт/i,
  /листовк/i,
  /\bbybit\b|трейдинг/i,
  // --- extended 2026-07-18, data-driven from the reject corpus (Roma). Each pattern was
  // validated against 392 CONFIRMED real vacancies with ZERO false positives; they only
  // fire on obvious non-jobs. NOTE: JS \w and \b are ASCII-only, so around Cyrillic we use
  // explicit [а-яё] classes / plain substrings instead (a \b before Cyrillic never matches).
  // USDT written in Cyrillic or mixed alphabets slips past the Latin \busdt\b above:
  // "ЮСДТ", "ЮСД(Т)", "ЮСД[Т]", "USДТ", "USDТ" — only ever crypto exchange, never a job.
  /юсдт|юсд\s*[([]\s*т|усдт|us[dд]т/i,
  // Loan-shark "financial help" spam. First-person "помогу" (the lender's voice) anchored to
  // money nouns — a real vacancy that offers help "с жильём / с оформлением / с визой" (noun
  // NOT in this set) and the employer voice "поможем" are deliberately left untouched.
  /помогу\s+с\s+(деньг|финанс|кредит|долг)/i,
  /закро[а-яё]*\s+(вам\s+)?долг|дам\s+в\s+долг|деньги\s+в\s+долг/i,
  // Airline-ticket agency ads (Seoul<->Tashkent seat sales). Matches the ticket-selling
  // service word only; bare "авиабилет" is left alone (a job may pay for a flight).
  /aviakassa|авиакасс/i,
  // Crypto-trading recruiting ("набор в Binance", "работа в бинанс").
  /\bbinance\b|бинанс/i,
  // Paid micro-task / listing-app promo ("листать вакансии ... задания в каждом городе").
  /листать\s+вакансии/i,
  // Money-for-nothing bait links.
  /(хочешь\s+денег|ищешь\s+деньги)\s*[?!]|залетай\s+сюда/i,
  // Recruiter self-promo with no concrete offer ("Работа нужна? Пиши на @…").
  /работа\s+нужна\s*\?\s*пиш/i,
  // Channel-join captcha system messages ("…подтвердить, что ты не бот…").
  /что\s+ты\s+не\s+бот|что\s+вы\s+не\s+робот/i,
  // SMM follower-selling service ("Instagram obunachi xizmati", "накрутка подписчиков").
  /\bobunachi\b|накрутк[а-яё]*\s+(подписчик|лайк)/i,
  // Cross-border money-transfer service (Uzbek "pul chiqarish", "ichki o'tkazma").
  /pul\s+chiqar|ichki\s+o'?tkazm/i,

  // --- extended 2026-07-19, crypto/exchange OTC spam from the "Unverified" tab (owner examples,
  // e.g. "Exchange Express — инфраструктурный OTC-сервис обмена цифровых активов … USDT/BTC/ETH").
  // Cyrillic patterns use the boundary helpers (durable lesson above), latin tokens use \b or the
  // both-sided tok() so a 3-letter ticker never matches inside a longer word.
  //
  // Bare tickers/acronyms as STANDALONE tokens: usdt is already caught above, add btc/eth and OTC.
  // Both-sided bound so "method"/"ethnic"/"otc-less" garbage cannot false-fire.
  tok('btc|eth|otc'),
  // "exchange" as a standalone word (beyond the "exchange express"/"inside exchange" combos above).
  tok('exchange'),
  // Cyrillic crypto root: крипта / крипты / криптовалюта / криптоактивы / криптообмен … (requires a
  // vowel after "крипт" so it never fires on an unrelated fragment). Mirrors ads/adspam.ts.
  re('крипт[оауеы][а-яё]*'),
  // "цифровых активов" / "цифровые активы" / "обмен цифровыми активами" — digital-asset OTC.
  re('цифров[а-яё]*\\s+актив[а-яё]*'),
  // "private-обмен" / "прайвет-обмен" — the OTC service's own label.
  re('(?:private|прайвет)[-\\s]?обмен[а-яё]*'),
  // "обмен" combined with a crypto/currency/capital word — NEVER bare "обмен" (a legit ad may say
  // "обмен опытом"). Both directions: "обмен валют/крипты/цифровых активов/капитала" and the
  // reverse "валютный/крипто/OTC-обмен". наличк/денег kept from the existing line for parity.
  re('обмен[а-яё]*[\\s-]+(?:валют|крипт|цифров|usdt|usd|наличк|денег|капитал)'),
  re('(?:валютн[а-яё]*|крипт[оауеы][а-яё]*|otc)[-\\s]?обмен[а-яё]*'),
];

// Emoji-carpet heuristic (owner 2026-07-19): promo blasts that are almost pure emoji with a couple
// of words (rows of 🎾/💎 etc.) must be cut before the AI. STRICT thresholds so legit ads with a
// few emoji bullets ("🏭 Завод в Ансане … зарплата 2.8 млн вон … @hr") always pass: an ad only
// counts as a carpet when it is emoji-HEAVY (>= 8 pictographs) AND text-LIGHT (< 40 letters/digits).
// A real vacancy always carries far more than 40 meaningful characters, so it can never trip this.
const EMOJI_MIN = 8;
const CONTENT_MAX = 40;
// /g so String.match returns every occurrence; .match() is stateless (no lastIndex), safe to reuse.
const EMOJI_RE = /\p{Extended_Pictographic}/gu;
const CONTENT_RE = /[\p{L}\p{N}]/gu;

/** True when the text is almost entirely emoji with little real content (see thresholds above). */
export function looksLikeEmojiCarpet(text: string): boolean {
  if (!text) return false;
  const emoji = (text.match(EMOJI_RE) ?? []).length;
  if (emoji < EMOJI_MIN) return false;
  const content = (text.match(CONTENT_RE) ?? []).length;
  return content < CONTENT_MAX;
}

/** True when the raw message is near-certain spam (pattern hit OR emoji carpet). */
export function looksLikeSpam(text: string | null | undefined): boolean {
  if (!text) return false;
  if (looksLikeEmojiCarpet(text)) return true;
  // No /g on the patterns, so .test() is stateless — safe to reuse the module-level array.
  const t = text.toLowerCase();
  return SPAM_PATTERNS.some((rx) => rx.test(t));
}
