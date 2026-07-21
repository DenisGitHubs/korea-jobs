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

// Zero-width chars (ZWSP/ZWNJ/ZWJ/word-joiner/BOM) that adult & spam bots splice INSIDE words
// (p‌r‌o‌f‌i‌l‌i‌m -> profilim) to dodge the matcher. Stripped in looksLikeSpam BEFORE lowercasing
// so the patterns see clean tokens. /g is for .replace() only — never .test() (stateful lastIndex).
const ZERO_WIDTH = /[​‌‍⁠﻿]/g;

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

  // --- extended 2026-07-21, data-driven from the 287-msg reject corpus; every pattern below was
  // validated to 0 FP on 521 CONFIRMED real vacancies (Roma). Only near-certain non-jobs fire.
  // Cyrillic tails use explicit [а-яё] classes (JS \w/\b are ASCII-only). RUBLE amounts, a bare
  // BOM prefix, Greek-letter obfuscation and the 🔞 glyph were TRIED and DROPPED — they collide
  // with real ads in this corpus (ruble micro-gigs; "🔞 можно с 16 лет"), so they are NOT here.
  //
  // g1 — "money scheme" recruiting bait. "тема" is context-bound (a real ad casually says "тема"),
  // so only the earn-scheme phrasings match, never the bare word.
  /(?:есть\s+тем[аку]|тем[аку]\s+(?:как|чтобы|для\s+заработ)|денежн[а-яё]*\s+тем)/iu,
  /поднять\s+(?:денег|\d+\s*к(?![а-яё]))/iu,
  /подъ[её]м\s+денег/iu,
  /лутать\s+к[еэ]ш/iu,
  /летсгоу/iu,
  /выводим\s+\d+\s*к(?![а-яё])/iu,
  /(^|[^а-яё])в\s+одно\s+дело/iu,
  // minor-targeting gig recruiting ("халтура/задание/подработка для подростков") — a mule tell.
  // The "задание для девочек" branch was dropped: it collided with a real micro-gig in the corpus.
  /(?:халтур[а-яё]*|задани[ея]|подработк[а-яё]*)\s+для\s+подрост/iu,

  // g3 — drops / money-mule / percent schemes.
  /доставк[уаи]?\s+котиков/iu,
  /сч[её]т(?:а|ов)?\s+в\s+аренду/iu,
  /работа\s+производится\s+за\s*%/iu,

  // g4 — visa / migration / document services. "под ключ" ALONE is dropped (construction ads say
  // "ремонт под ключ"); it only fires when a migration/visa word sits IN THE SAME SENTENCE as
  // "под ключ" — PROXIMITY, not two independent whole-text lookaheads. The old two-lookahead form
  // fired whenever "под ключ" AND a visa word appeared ANYWHERE in the message, so a real
  // construction ad ("ремонт под ключ" in one sentence + "виза F4" in another) was a false drop on
  // an irreversible filter. Now two orders (под ключ→word, word→под ключ) with a same-sentence
  // window [^\n.!?]{0,60}: the \n/./!/? boundary also keeps bullet-formatted construction ads
  // (…под ключ⏎…виза E-9…) safely OUT, so a genuine visa-services post that splits the two across a
  // bullet line is left for the model — 0 FP on the real corpus is the hard owner gate here.
  /(^|[^a-zа-яё])k[\s\-]?eta(?![a-zа-яё])/iu,
  // The migration-word group is guarded by a LEFT WORD BOUNDARY in both orders (Censor, gate
  // 21.07): "виз" is a 3-letter stem that also lives inside "суперВИЗор"/"телеВИЗор", and the
  // proximity window on its own could stop mid-word. The boundary char is required between the
  // window and the word group, so "супервизора ... под ключ" can never fire.
  // NB: the boundary char itself must stay inside the sentence window (no \n/./!/?), or it would
  // re-open the bullet-line bridge the window is there to close.
  /под\s+ключ[^\n.!?]{0,59}[^а-яёa-z0-9\n.!?](?:виз[а-яё]*|k-?eta|внж|птж|гражданств|миграц|легализ|депорт|консульск|вид\s+на\s+жительств)|(^|[^а-яёa-z0-9])(?:виз[а-яё]*|k-?eta|внж|птж|гражданств|миграц|легализ|депорт|консульск|вид\s+на\s+жительств)[^\n.!?]{0,60}под\s+ключ/iu,
  /консульск[а-яё]*\s+сбор/iu,
  /разные\s+диплом|водительски[ае]\s+удостоверен/iu,
  /безлимитн[а-яё]*\s+симкарт|симкарт[а-яё]*\s+(?:для\s+нелегал|с\s+безлимит)/iu,

  // g5 — tether / TRC-20 (extends the USDT coverage; latin-lookalike "Tеззер" + network tag).
  // The left boundary wraps ALL word alternatives (тезер/тетхер/tether) — bare latin "tether" used
  // to sit outside the barrier and could fire mid-word. TRC-20 keeps its own digit-aware boundary.
  /(^|[^а-яёa-z])(?:[tт][еэ]з{1,2}ер|тетхер|tether)|(^|[^a-zа-яё0-9])(?:тр{1,2}к|trc)\s?20(?![a-zа-яё0-9])/iu,

  // g6 — casino / bonus promo.
  /бонус\s+сразу\s+на\s+баланс|моментальн[а-яё]*\s+бонус|мгновенн[а-яё]*\s+регистрац|укажите\s+промокод|(^|[^а-яё])промокод/iu,

  // g8 — adult / dating spam (Uzbek). NB: the zero-width strip in looksLikeSpam is REQUIRED here —
  // these bots inject ZW chars inside the words below to dodge this match.
  /profilim(?:ga|ni)|profildagi\s+guruh/iu,
  /faqat\s+kattalar\s+uchun|yolg['ʻ']?izmisan|afsuslanmays/iu,
  /проститутк/iu,

  // g9 — Telegram spam-ban unblock service (Uzbek).
  /spamga\s+tushgan/iu,

  // g10 — channel/folder-join promo.
  /добав(?:ьте|ить)\s+папку\s+с\s+канал/iu,

  // g11 — remote / not-in-Korea work. Ruble AMOUNTS were dropped (the corpus is full of real
  // ruble-denominated micro-gigs); only these unambiguous phrasings stay.
  /(^|[^а-яё])удал[её]нк/iu,
  /городах\s+росси/iu,

  // g12 — shill "they paid me instantly" reviews / paid-survey bait. "за опрос" sits INSIDE the
  // shared left-boundary group so the barrier guards every alternative, not just the first.
  /(^|[^а-яё])(?:скинули\s+сразу|сразу\s+скинули|за\s+даром\s+выдали|выдали\s+за\s+даром|за\s+опрос)/iu,

  // g13 — high-precision one-offs from the corpus.
  /facebook\.com\/share/iu,
  // Shared left boundary wraps BOTH alternatives (previously only "я исключил" was guarded).
  /(^|[^а-яё])(?:ссылк[уи]\s+без\s+разрешени|я\s+исключил)/iu,
  // Shared left boundary wraps BOTH alternatives (previously only "so'm" was guarded; digits are
  // allowed before, so "5 kg + 10 kg" and "1000so'm" still match).
  /(^|[^a-zа-яё])(?:\d\s*kg\s*\+\s*\d+\s*kg|so['ʻ]m(?![a-z]))/iu,
  /такси\s+по\s+корее/iu,
  /нужны\s+бабки/iu,
  /(?:напиши(?:те)?|пиши)\s*\+\s+в\s+лс/iu,
  /oy\s+garantiya/iu,
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

// Pharmacy-blast heuristic (owner draft, validated 2026-07-21): messages carpeted with the 💊 pill
// glyph are drug ads, never manual-labour jobs. Require >= 2 pills so a single decorative 💊 cannot
// trip it (0 FP on 521 real). The 🔞 glyph was TRIED and DROPPED — a real ad uses "🔞 можно с 16 лет".
const PILL_MIN = 2;
const PILL_RE = /💊/gu;
/** True when the message is carpeted with the 💊 pill glyph (>= 2 occurrences). */
export function looksLikePharma(text: string): boolean {
  if (!text) return false;
  return (text.match(PILL_RE) ?? []).length >= PILL_MIN;
}

/** True when the raw message is near-certain spam (pattern hit OR emoji carpet OR pharma blast). */
export function looksLikeSpam(text: string | null | undefined): boolean {
  if (!text) return false;
  // Structural heuristics run on the RAW text (they count emoji/pictographs, not letters).
  if (looksLikeEmojiCarpet(text)) return true;
  if (looksLikePharma(text)) return true;
  // Strip zero-width chars BEFORE lowercasing (adult/dating bots splice them inside words to hide
  // from the g8 patterns); MUST precede toLowerCase so the boundary helpers see clean tokens.
  // No /g on the patterns, so .test() is stateless — safe to reuse the module-level array.
  const t = text.replace(ZERO_WIDTH, '').toLowerCase();
  return SPAM_PATTERNS.some((rx) => rx.test(t));
}
