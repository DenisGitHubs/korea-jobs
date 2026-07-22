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
  // Cyrillic tails use explicit [а-яё] classes (JS \w/\b are ASCII-only). A bare BOM prefix,
  // Greek-letter obfuscation and the 🔞 glyph were TRIED and DROPPED — they collide with real ads
  // ("🔞 можно с 16 лет"), so they are NOT here. RUBLE amounts were dropped here too, but the owner
  // REVERSED that on 2026-07-22 ("плата рублями = скам"): ruble pay is now caught by looksLikeRublePay
  // (below), NOT by this array.
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

  // g11 — remote / not-in-Korea work. Ruble AMOUNTS live in looksLikeRublePay now (owner 2026-07-22,
  // ruble = scam on a Korea board); only these unambiguous non-ruble remote phrasings stay here.
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

  // --- CANDIDATE D (owner decision 2026-07-22, "остаток-3"): first-person JOB-SEEKER requests. A
  // person ASKING to be brought over / sponsored is not a vacancy — the board lists offers, not
  // requests. EXACT application phrasings only (validated 0 FP on 521 confirmed real vacancies): the
  // seeker's own voice "я хочу поехать/поработать/устроиться", "мне нужно приглашение", "оплачу из
  // своей зарплаты/зп", "помогите мне со всеми расходами". Cyrillic-safe boundaries on EVERY phrase
  // (Censor hardening «остаток-3», same durable lesson as RENT_JOB_WORD): the LEFT boundary is
  // (^|[^а-яё]) on ALL FOUR — without it "оплачу" is a substring of "доплачу/переоплачу/недоплачу"
  // (a real "доплата" ad) and "помогите" could match mid-word; and the "зп" tail closes on a
  // Cyrillic-safe (?![а-яё]) lookahead, NEVER an ASCII \b — a \b after the Cyrillic "п" never
  // matches, so "оплачу … зп" (space/EOL after) used to fail silently.
  /(^|[^а-яё])я\s+хочу\s+(?:поехать|поработать|устро)/iu,
  /(^|[^а-яё])мне\s+нужн[оаы]\s+приглашени/iu,
  /(^|[^а-яё])оплачу\s+(?:их\s+)?(?:из\s+)?(?:своей\s+)?(?:зарплат|зп(?![а-яё]))/iu,
  /(^|[^а-яё])помогите\s+мне\s+со\s+всеми\s+расход/iu,
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

// --- Letter-doppelganger obfuscation (owner "остаток-2", validated 2026-07-21, ~23 catches). The
// worker-recruiting mule blasts disguise Russian words by swapping letters for GREEK look-alikes
// (α σ π ρ δ τ κ Η Ρ Γ Β Μ Τ Ο Φ) that render almost identically: "0нлαúн Poδoτα",
// "Τσльκσ Γρaждaнe ΡΦ", "Сᴇгσдня мσгу πσмσчь с дᴇньгᴀми". Per-WORD, not per-char: split the raw text
// into letter tokens (\p{L}\p{M} runs, so digits/spaces/dashes break tokens), call a token "mixed"
// only when it holds Cyrillic AND Greek inside the SAME word, and demand at least two such words.
//
// GREEK-ONLY, DROPPED THE LATIN BRANCH (hard 0-FP gate, durable lesson). The owner draft said
// "Cyrillic + (Greek OR Latin)", but validation on 521 confirmed real vacancies proved the Latin
// branch false-fires on GENUINE Korea micro-gigs: real posters type Latin look-alikes а/о/е/с/р/х to
// dodge OTHER keyword filters, so real ads DO carry Cyrillic+Latin words ("Фаcовка cнюca 9.000",
// "Пoгрузка нoчная 8.000", "Рaзлoжить Gorila пo пoлкам мaeазина"). Greek look-alikes, by contrast,
// essentially never appear in a genuine Cyrillic ad. Requiring Greek keeps every residual catch
// (all 24 residual blasts contain Greek) and drops all 9 genuine-gig false positives. This is the
// SAME class of lesson as why the per-character version was dropped: Latin/Cyrillic homoglyphs are
// legitimately mixed by humans; Greek is the reliable spam signal.
//
// Why >= 2 same-word Greek: "IT-специалист"/"Wi-Fi" split on the dash into pure-script tokens (never
// mixed); a Korean word is Hangul-only (hasCyr false). Structural, on the RAW text (case is
// irrelevant to script identity), same as the emoji-carpet heuristic.
const SCRIPT_CYR = /\p{Script=Cyrillic}/u;
const SCRIPT_GREEK = /\p{Script=Greek}/u;
// /gu so String.match returns EVERY token; .match() is stateless (no lastIndex) — safe to reuse.
// [\p{L}\p{M}]+ keeps combining marks attached to their base letter, so a decomposed "ú" (u + U+0301)
// stays inside one token instead of splitting the word.
const WORD_TOKEN_RE = /[\p{L}\p{M}]+/gu;
const MIXED_WORD_MIN = 2;

/** True when >= 2 words each mix Cyrillic with Greek look-alike letters (see block above). */
export function looksLikeMixedScript(text: string): boolean {
  if (!text) return false;
  // Strip zero-width chars BEFORE tokenizing (Censor, gate 21.07): the same bots that mix
  // scripts also splice ZWSP inside words — an unstripped ZW would split the token and let a
  // greek-cyrillic word slip through. Mirrors looksLikeLinkOnly/looksLikeEmptyMessage.
  const tokens = text.replace(ZERO_WIDTH, '').match(WORD_TOKEN_RE);
  if (!tokens) return false;
  let mixed = 0;
  for (const t of tokens) {
    if (SCRIPT_CYR.test(t) && SCRIPT_GREEK.test(t)) {
      if (++mixed >= MIXED_WORD_MIN) return true;
    }
  }
  return false;
}

// A "real letter" for the link-only / empty heuristics below: Cyrillic, Latin (incl. the phonetic
// small-caps, all Latin script) or Hangul. Greek is deliberately NOT a letter here — a pure-Greek
// blast is caught by looksLikeMixedScript, and treating Greek as "no letters" is per the owner spec.
const LETTER_RE = /[\p{Script=Cyrillic}\p{Script=Latin}\p{Script=Hangul}]/u;

// --- Link-only messages (owner "остаток-2", validated 2026-07-21). After stripping spaces and
// zero-width chars the message is nothing but a URL (t.me / http / https) with no other letters —
// a bare channel-drop, e.g. "https://t.me/G1ramm" posted three times. We remove the URLs and, if
// no real letter survives while at least one URL was present, it is link-only spam. A real ad that
// merely CONTAINS a contact link ("Пишите https://t.me/hr_ansan") keeps its other letters and never
// trips this. /\S+/ is safe: URLs are stripped before the whitespace check, not after collapsing.
export function looksLikeLinkOnly(text: string): boolean {
  if (!text) return false;
  const t = text.replace(ZERO_WIDTH, '');
  const hasUrl = /https?:\/\//i.test(t) || /\bt\.me\//i.test(t);
  if (!hasUrl) return false;
  const stripped = t
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\bt\.me\/\S+/gi, ' ');
  return !LETTER_RE.test(stripped);
}

// --- Empty / greeting-only messages (owner "остаток-2", validated 2026-07-21). Two shapes:
// (a) the message carries NO letter at all (Cyrillic/Latin/Hangul) — only emoji/signs/digits, e.g.
//     "💋", "💞🔞", "01072771369", "来做" (Han is not one of the three scripts, so it counts as none);
// (b) the WHOLE message, once emoji/punctuation/digits are trimmed, is EXACTLY one greeting from the
//     fixed list below — a bare "Привет" with nothing else. EXACT full-message match, never a
//     substring: "Привет! Нужны 2 человека на завод…" is multi-word and stays for the model, and
//     "…uchun raxmat🤗" is not equal to "raxmat" so it also stays.
const GREETINGS = new Set([
  'привет', 'здравствуйте', 'салам', 'ассалому алейкум',
  'hi', 'hello', 'raxmat', 'рахмат', 'спасибо',
  // E-lite (owner decision 2026-07-22, "остаток-3"): two EXACT one-liner chit-chat requests that
  // are a whole message on their own — never a job. Added here (not as a separate rule) exactly as
  // the owner allowed; validated with 0 FP on 521 confirmed real vacancies. NOTE: "ждут вашего
  // ответа" was deliberately NOT taken (owner), and bare "как" was left out (too common a word).
  'помогите мне', 'напиши мне',
]);

export function looksLikeEmptyMessage(text: string): boolean {
  if (!text) return false;
  const stripped = text.replace(ZERO_WIDTH, '');
  // (a) non-blank but no real letter anywhere.
  if (stripped.trim() !== '' && !LETTER_RE.test(stripped)) return true;
  // (b) exact single-greeting message (drop emoji/punctuation/digits, collapse spaces, lowercase).
  const bare = stripped
    .toLowerCase()
    .replace(/[^\p{L}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return GREETINGS.has(bare);
}

// --- CANDIDATE A: apartment/room RENTAL ads (owner decision 2026-07-22, "остаток-3"). This is a
// JOBS board; a "сдаётся ванрум/원룸 …" post or a deposit-format price ("1млн/380тыс") is housing,
// never a vacancy. Structural, by the shape of looksLikeEmptyMessage (its own ZW-strip + lowercase).
// Ported BYTE-IDENTICAL from the validated probe (0 FP on 521 confirmed real vacancies).
//   • RENT_JOB_WORD — any employer/offer word (требуется / вакансия / зарплата / з/п / арбайт /
//     подработка / график / нужны люди / ищем работника / смена / постоянка / оплата). If it is
//     present the message is an OFFER (an employer may throw in a вонрум as a PERK), so it is NEVER
//     cut here — this guard is exactly what spared the real employer-with-housing ad #53.
//   • RENT_SDAETSYA — "сдаётся/сдается" as a whole word (cyrillic-safe boundaries, never ASCII \b).
//   • RENT_HOUSE_N — a dwelling noun (ванрум/вонрум/원룸/ван рум/комната/жильё/квартира).
//   • RENT_PRICE_FMT — the "Nмлн / Nтыс" deposit-then-rent format a rental quotes; a vacancy never does.
// Fires on (сдаётся AND dwelling-noun) OR the deposit price format — but ONLY when no job word is present.
// нуж(?:ен|н[а-яё]*) also catches the SINGULAR "нужен работник" (Censor «остаток-3»): the old
// "нужны?" caught нужн/нужны but MISSED "нужен", so a real employer ad "нужен работник … сдаётся
// ванрум" slipped past this guard and was wrongly cut as housing. This is a defensive gate — a wider
// job-word match only SPARES more real offers, so broadening toward "нужен" is safe (0-FP direction).
const RENT_JOB_WORD =
  /(^|[^а-яё])(требу[а-яё]*|ваканси[а-яё]*|зарплат[а-яё]*|з[\/. ]?п(?![а-яё])|арбайт[а-яё]*|подработк[а-яё]*|график[а-яё]*|нуж(?:ен|н[а-яё]*)\s+(?:люди|человек|работник|мужчин|женщин|парн|девушк|сотрудник)|ищем\s+(?:работник|людей|сотрудник)|смена[а-яё]*|постоянк[а-яё]*|оплата)/iu;
const RENT_SDAETSYA = /(^|[^а-яё])сда[её]тся(?![а-яё])/iu;
// Left boundary (^|[^а-яёa-z0-9]) on every dwelling alternative (Censor «остаток-3»: match the file's
// boundary convention, cf. the B helper) so a noun can't fire glued inside a longer word; the Cyrillic
// tails ([а-яё]*) still cover the word's right side and Korean 원룸 rides the same boundary.
const RENT_HOUSE_N =
  /(^|[^а-яёa-z0-9])(?:ванрум|вонрум|원룸|ван\s?рум|комнат[а-яё]*|жиль[её]|квартир[а-яё]*)/iu;
const RENT_PRICE_FMT = /\d+\s*млн\s*\/\s*\d+\s*тыс/iu;

/** True when the message is an apartment/room RENTAL ad, not a job (see block above). */
export function looksLikeHousingRental(text: string | null | undefined): boolean {
  if (!text) return false;
  // ZW-strip + lowercase (mirrors looksLikeSpam / the probe's `norm`) so obfuscated copies match.
  const t = text.replace(ZERO_WIDTH, '').toLowerCase();
  if (RENT_JOB_WORD.test(t)) return false; // employer-with-housing safeguard (spared #53)
  return (RENT_SDAETSYA.test(t) && RENT_HOUSE_N.test(t)) || RENT_PRICE_FMT.test(t);
}

// --- CANDIDATE C: a job-SEEKER's short self-introduction (owner decision 2026-07-22, "остаток-3").
// "Меня зовут …, мне 25 лет, я из Узбекистана, у меня нет визы" is a résumé blurb, not an offer. TWO
// hard gates TOGETHER give the 0-FP result on 521 confirmed real vacancies:
//   (1) LENGTH — at most 6 letter-words. A real ad is longer; this alone kills almost every FP.
//   (2) a FIRST-PERSON intro template from the fixed list below.
// CYRILLIC-SAFE boundaries (durable lesson, and the exact bug this filter hit on #66/#71): ASCII \b /
// \w never span а-я, so the left boundary is (^|[^а-яё]) and the right is (?![а-яё]) — NEVER \b.
// Ported BYTE-IDENTICAL from the validated probe.
const SEEKER_INTRO: RegExp[] = [
  /^\s*меня\s+зовут(?![а-яё])/iu,
  /(^|[^а-яё])мне\s+\d+\s*(?:лет|год)/iu,
  /(^|[^а-яё])я\s+(?:из\s+)?граждан[а-яё]*/iu,
  /(^|[^а-яё])я\s+из\s+[а-яё]+стан/iu,
  /(^|[^а-яё])я\s+в\s+сейчас(?![а-яё])/iu,
  /(^|[^а-яё])у\s+меня\s+нет\s+(?:виз|денег|деньг|документ)/iu,
];
// Letter-word tokens (Cyrillic + Latin) for the length gate — matches the probe's tokCount exactly.
// /g is for String.match only (stateless — no lastIndex); NEVER .test() on this one.
const SEEKER_WORD_RE = /[а-яёa-z]+/g;
const SEEKER_MAX_WORDS = 6;

/** True when the message is a short first-person job-seeker self-intro (see block above). */
export function looksLikeSeekerIntro(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.replace(ZERO_WIDTH, '').toLowerCase();
  if ((t.match(SEEKER_WORD_RE) ?? []).length > SEEKER_MAX_WORDS) return false; // hard length gate
  return SEEKER_INTRO.some((rx) => rx.test(t));
}

// --- Ruble-denominated pay (owner decision 2026-07-22: "везде где пишут плата рублями это скам").
// This board is jobs *in Korea*, where legal pay is always in won (₩ / вон). A ruble figure means the
// post is either not-in-Korea or courier-slang bait ("поднять капусту", micro-gigs "6400₽ за коробки")
// — never a genuine Korea vacancy. NB: this deliberately REVERSES the 2026-07-21 stance ("ruble
// micro-gigs are real, keep them"); the same posts spared back then are now dropped ON PURPOSE.
// Validated on real-vacancies-full.json/521: 63 hits, EVERY one a ruble sum, ZERO carry a вон/₩ token
// (so no won-priced Korea ad is ever caught) — the ruble-vs-won split is the hard gate, not recall.
//
// Three shapes, matched on the ZW-stripped, lowercased text (see looksLikeRublePay):
//  (0) the ₽ sign anywhere;
//  (1) the word руб / рубль / рубля / рублей … — the abbreviation "руб" only when NOT followed by
//      another letter (so "рубашка"/"рубить"/"рубеж"/"рубрика"/"рубленый" are spared), and the full
//      forms via an explicit ending list bounded on the right (so "рубленый" = рубл+еный never fires);
//  (2) a number loosely followed by "р" / latin "p" and then a NON-letter — "3000р", "20 000р",
//      "1100 р", "за 300 р.". That right-hand [^letter] lookahead is what keeps phones
//      ("010-3000-1234"), won amounts ("300000 вон"), and worker counts ("3000 работников" → р+а)
//      out. Cyrillic-safe boundaries, /iu; both р (Cyrillic) and p (latin look-alike) are accepted.
const RUBLE_PATTERNS: RegExp[] = [
  /₽/,
  /(^|[^а-яёa-z])(?:руб(?![а-яёa-z])|рубл(?:ями|ях|ям|ей|ём|ем|ь|ю|я|е|и)(?![а-яёa-z]))/iu,
  /\d[\d\s.,]*[рp](?![а-яёa-z])/iu,
];

/** True when the post quotes pay in rubles (₽ / руб* / "3000р") — scam on a Korea-jobs board. */
export function looksLikeRublePay(text: string | null | undefined): boolean {
  if (!text) return false;
  // Same ZW-strip + lowercase as looksLikeSpam, so obfuscated "3000 руб" (ZWSP-spliced) still fires.
  const t = text.replace(ZERO_WIDTH, '').toLowerCase();
  return RUBLE_PATTERNS.some((rx) => rx.test(t));
}

/** True when the raw message is near-certain spam (pattern hit OR emoji carpet OR pharma blast OR
 *  mixed-script obfuscation OR link-only drop OR empty/greeting-only message OR ruble-denominated pay
 *  OR apartment/room rental OR a short job-seeker self-intro). */
export function looksLikeSpam(text: string | null | undefined): boolean {
  if (!text) return false;
  // Structural heuristics run on the RAW text (they inspect scripts/emoji/URLs, not lowercased words);
  // looksLikeHousingRental / looksLikeSeekerIntro do their OWN ZW-strip + lowercase internally.
  if (looksLikeEmojiCarpet(text)) return true;
  if (looksLikePharma(text)) return true;
  if (looksLikeMixedScript(text)) return true;
  if (looksLikeLinkOnly(text)) return true;
  if (looksLikeEmptyMessage(text)) return true;
  if (looksLikeRublePay(text)) return true;
  if (looksLikeHousingRental(text)) return true; // Candidate A (остаток-3): rental, not a job
  if (looksLikeSeekerIntro(text)) return true;   // Candidate C (остаток-3): seeker self-intro
  // Strip zero-width chars BEFORE lowercasing (adult/dating bots splice them inside words to hide
  // from the g8 patterns); MUST precede toLowerCase so the boundary helpers see clean tokens.
  // No /g on the patterns, so .test() is stateless — safe to reuse the module-level array.
  const t = text.replace(ZERO_WIDTH, '').toLowerCase();
  return SPAM_PATTERNS.some((rx) => rx.test(t));
}
