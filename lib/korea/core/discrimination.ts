// lib/korea/core/discrimination.ts
//
// Phrases that limit a hiring offer's audience by GENDER or AGE — ONE first-party detector, shared
// by every place that must care:
//   * the OWNER'S BOT preview of /post (scheduled/parse.ts) WARNS him about them, and publishing is
//     not blocked — he may be posting something that is not a job offer at all. 🔴 This is the bot,
//     his own scheduled posts: the Mini App's placement form warns an ORDINARY AUTHOR about nothing
//     (checked 2026-10-21). Telling the author that such words cost him the week is separate work,
//     handed to the owner — do not read the list below as "the person was warned";
//   * the FREE featured lift (ads/featured.ts) is REFUSED to an ad whose own text carries a gender
//     restriction (Законник, 2026-10-21): while an offer merely passes through from somebody else's
//     channel we are only relaying it, but a card WE placed and WE lifted to the top of the feed by
//     our own mechanics is ours — and distributing a gender-restricted vacancy is punishable in RU.
// It lives in core/ precisely so those two readings cannot drift into two different vocabularies.
//
// NOTE ON SCOPE: this reads the TEXT, because that is the only signal we have. The ad form has no
// "who is wanted" field at all (AdInput / user_ads carry no gender column — the feed reports 'any'
// for every user ad), so there is nothing structured to check. A phrase the regexes miss is a miss,
// not a lie: the lift is a bonus, and refusing it on a confident match is the cheap, safe side.
//
// UNICODE-AWARE BOUNDARIES ON PURPOSE. `\b` and `\w` in JavaScript are ASCII-only: /\bженщины\b/
// matches NOTHING in a Russian sentence, so the whole screening silently found zero phrases (the
// scheduled/parse tests caught exactly that). `(?<![\p{L}])` / `(?![\p{L}])` under /u are the real
// "not inside another word" guards, in any alphabet.

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

/** Hard ceiling on how many fragments we collect — the callers only need a handful. */
const MAX_HINTS = 6;

/** Collect the matches of one regex family into `found` (de-duplicated, lower-cased, capped). */
function collect(text: string, res: RegExp[], found: Set<string>): Set<string> {
  for (const re of res) {
    if (found.size >= MAX_HINTS) return found;
    // Fresh lastIndex per call: the module-level regexes carry /g.
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const hit = m[0].trim().replace(/\s+/g, ' ');
      if (hit) found.add(hit.toLowerCase());
      if (found.size >= MAX_HINTS) return found;
    }
  }
  return found;
}

/** GENDER-limiting phrases only (the featured lift's gate). */
export function findGenderHints(text: string): string[] {
  return [...collect(text, GENDER_RE, new Set<string>())];
}

/** AGE-limiting phrases only. */
export function findAgeHints(text: string): string[] {
  return [...collect(text, AGE_RE, new Set<string>())];
}

/**
 * GENDER ∪ AGE phrases, gender first — the /post preview's warning list. Behaviour (order, the
 * de-dup, the cap of 6) is byte-for-byte what scheduled/parse.ts did before this module existed.
 */
export function findDiscriminationHints(text: string): string[] {
  const found = collect(text, GENDER_RE, new Set<string>());
  return [...collect(text, AGE_RE, found)];
}
