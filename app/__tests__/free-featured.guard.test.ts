/**
 * Guards for the FREE placement (owner's decisions, 21.10.2026).
 *
 * Three promises are nailed down here, because each of them is one careless edit
 * away from turning into a lie on the screen:
 *
 *  1. «От автора» speaks of ORIGIN, not of quality. It is drawn from
 *     `source_kind === 'user'` — on EVERY self-posted ad, for as long as the ad
 *     lives — and NEVER from the free week at the top of the feed. A mark that
 *     arrived and left together with the privilege could only be read as "trust
 *     this one more", which is precisely what the project does not say.
 *  2. The paid label «Реклама» is law, and the end of payment does not repeal it:
 *     it stays, on its OWN path (`promo`), and the two paths may not merge.
 *  3. Nothing on the screen claims the listing, the author or his words were
 *     checked — while the sentence that says we do NOT check them stays visible.
 *
 * The dictionaries go through the REAL i18next with the real keys the screens ask
 * for (what the person reads), and the wiring is read out of the source TREE, not
 * pattern-matched: a regexp only ever recognises the shapes its author thought of.
 *
 * The app has no test runner of its own; this file lives in the ROOT vitest set
 * (`npx vitest run` from the project root picks it up by the default include).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import i18next from 'i18next';
import ts from 'typescript';
import { ru } from '../src/i18n/ru';
import { en } from '../src/i18n/en';
import { PLACEMENT_RULES } from '../src/content/legal/placement-rules';
import { PLACEMENT_RULES_PATH } from '../src/content/legal/paths';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(APP, 'src');
const f = (rel: string): string => resolve(APP, rel);

const VACANCY_CARD = f('src/components/VacancyCard.tsx');
const VACANCY_SCREEN = f('src/screens/VacancyScreen.tsx');
const PARTNERS = f('src/screens/PartnersScreen.tsx');
const POST = f('src/screens/PostScreen.tsx');
const APP_TSX = f('src/App.tsx');
const OUTSIDE = f('src/components/OutsideTelegram.tsx');
const API_TYPES = f('src/shared/types/api.ts');
const PATHS = f('src/content/legal/paths.ts');
const DOC_SCREEN = f('src/screens/PlacementRulesScreen.tsx');

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

/**
 * Strip comments before looking for code. The comments here deliberately EXPLAIN
 * the invariants in prose (including the words the guards forbid), and a guard
 * that read prose as code would fail on its own explanation.
 */
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every .ts/.tsx file under src/, so a new reader cannot slip past a guard. */
function srcFiles(dir: string = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return srcFiles(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

function ast(file: string): ts.SourceFile {
  return ts.createSourceFile(file, read(file), ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
}

function collect(node: ts.Node, pred: (n: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = [];
  const walk = (n: ts.Node): void => {
    if (pred(n)) found.push(n);
    n.forEachChild(walk);
  };
  walk(node);
  return found;
}

type Gate = { condition: string; branch: string };

/**
 * For every place `needle` occurs in `file`, the INNERMOST `if` / `? :` that
 * decides whether it is rendered, with that branch's text. Positions come from the
 * file text and the enclosing node from the tree, so any legal way of writing the
 * same condition is recognised.
 */
function gatesOf(file: string, needle: string): Gate[] {
  const text = read(file);
  const nodes = collect(ast(file), (n) => ts.isIfStatement(n) || ts.isConditionalExpression(n));
  const out: Gate[] = [];
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) {
    const holders = nodes.filter((n) => n.getStart() <= i && i < n.getEnd());
    expect(holders.length, `${needle} at ${i} in ${file} is rendered under no condition`).toBeGreaterThan(0);
    const inner = holders.reduce((a, b) => (b.getEnd() - b.getStart() < a.getEnd() - a.getStart() ? b : a));
    const condition = (
      ts.isIfStatement(inner) ? inner.expression : (inner as ts.ConditionalExpression).condition
    ).getText();
    if (!out.some((g) => g.condition === condition)) out.push({ condition, branch: inner.getText() });
  }
  return out;
}

/** A bare identifier condition, expanded through its `const x = …` in the same file. */
function expand(file: string, condition: string): string {
  if (!/^[A-Za-z_$][\w$]*$/.test(condition)) return condition;
  const decl = (collect(ast(file), ts.isVariableDeclaration) as ts.VariableDeclaration[]).find(
    (d) => d.name.getText() === condition,
  );
  return decl?.initializer ? `${condition} = ${decl.initializer.getText()}` : condition;
}

/** The real i18next with the real dictionaries — what the person reads. */
async function dictionary(lng: 'ru' | 'en'): Promise<(key: string) => string> {
  const i18n = i18next.createInstance();
  await i18n.init({
    resources: { ru: { translation: ru }, en: { translation: en } },
    lng,
    fallbackLng: 'ru',
    interpolation: { escapeValue: false },
  });
  return (key: string) => String(i18n.t(key));
}

/** Flat dotted key list of a dictionary. */
function keysOf(node: unknown, prefix = ''): string[] {
  if (node === null || typeof node !== 'object') return [prefix];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
    keysOf(v, prefix ? `${prefix}.${k}` : k),
  );
}

/* ── the trust-claim rule ──────────────────────────────────────────────────── */

/**
 * Stems of a CLAIM that something was checked. Stems, not whole words: Russian
 * declines («проверено», «надёжного»), and the claim is the same claim.
 */
const CLAIM_STEMS = [
  'проверен',
  'проверил',
  'надёжн',
  'надежн',
  'гарант',
  'безопасн',
  'verified',
  'trusted',
  'guarantee',
  'safe',
];

/** A denial in the same sentence makes the stem honest, not a promise. */
const DENIALS = ['не', 'нет', 'no', 'not', 'never', "don't", 'don’t', 'cannot'];

function denied(sentence: string): boolean {
  return DENIALS.some((d) =>
    new RegExp(`(^|[^\\p{L}])${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}]|$)`, 'iu').test(sentence),
  );
}

/**
 * Sentences that CLAIM a check. Measured by the SENTENCE, never by the root: the
 * honest note itself says «мы не проверяем», and a root-level ban would paint the
 * truth red while «проверено» two words later went through.
 */
function trustClaims(value: string): string[] {
  return value
    .split(/[.!?…]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => CLAIM_STEMS.some((w) => s.toLowerCase().includes(w)) && !denied(s));
}

describe('free placement: the mark may not promise that anything was checked', () => {
  // Both canaries are literal strings on purpose, never `t(...)`: a self-check that
  // reads the live dictionary proves the state of that string, not the rule.
  const MUST_GO_RED = [
    'Объявление проверено, работодатель надёжный.',
    'This listing is verified and the employer is trusted.',
  ];
  const MUST_STAY_GREEN = [
    'Кто он и правда ли написанное, мы не проверяем.',
    'Надёжность мы не гарантируем.',
    'We do not guarantee the ad is safe.',
  ];

  it('the rule itself: a claim is caught, the same words denied are not', () => {
    for (const bad of MUST_GO_RED) expect(trustClaims(bad), bad).not.toEqual([]);
    for (const good of MUST_STAY_GREEN) expect(trustClaims(good), good).toEqual([]);
  });

  it('the badge and its note claim nothing, in both languages', async () => {
    for (const lng of ['ru', 'en'] as const) {
      const t = await dictionary(lng);
      for (const key of ['vacancy.directBadge', 'vacancy.directNote']) {
        const value = t(key);
        expect(value, `${lng} ${key} is missing`).not.toBe(key);
        expect(trustClaims(value), `${lng} ${key}: «${value}»`).toEqual([]);
      }
    }
  });

  it('the note still says, in plain words, that we check nothing', async () => {
    // The ONLY place on the vacancy screen that says it about the author. The key
    // must exist AND be rendered — a dictionary line nobody draws says nothing.
    expect((await dictionary('ru'))('vacancy.directNote')).toContain('не проверяем');
    expect((await dictionary('en'))('vacancy.directNote')).toContain('do not check');
    expect(read(VACANCY_SCREEN)).toContain("t('vacancy.directNote')");
  });
});

describe('free placement: the mark comes from ORIGIN, the «Реклама» label from payment', () => {
  it('the feed card draws the mark from source_kind and the label from promo', () => {
    const mark = gatesOf(VACANCY_CARD, "t('vacancy.directBadge')");
    expect(mark, 'the mark must have exactly one condition in the card').toHaveLength(1);
    const markCond = expand(VACANCY_CARD, mark[0]!.condition);
    expect(markCond).toMatch(/source_kind === 'user'/);
    expect(markCond, 'the mark may not ride on the week at the top').not.toMatch(/featured/i);
    expect(markCond, 'the mark may not ride on paid advertising').not.toMatch(/promo/i);

    const ad = gatesOf(VACANCY_CARD, "t('vacancy.adBadge')");
    expect(ad).toHaveLength(1);
    const adCond = expand(VACANCY_CARD, ad[0]!.condition);
    expect(adCond).toMatch(/isPromo\(|\bpromo\b/);
    expect(adCond).not.toMatch(/source_kind/);
    expect(adCond, 'two different things need two different conditions').not.toBe(markCond);
  });

  it('the open card draws them the same way — both places, one rule', () => {
    const mark = gatesOf(VACANCY_SCREEN, "t('vacancy.directBadge')");
    expect(mark.length, 'badge row + plate title are both gated the same way').toBe(1);
    const markCond = expand(VACANCY_SCREEN, mark[0]!.condition);
    expect(markCond).toMatch(/source_kind === 'user'/);
    expect(markCond).not.toMatch(/featured|promo/i);

    for (const gate of gatesOf(VACANCY_SCREEN, "t('vacancy.adBadge')")) {
      expect(expand(VACANCY_SCREEN, gate.condition), 'the «Реклама» label hangs on payment').toMatch(
        /isPromo\(|\bpromo\b/,
      );
    }
  });

  it('the mark is worn by EVERY self-posted ad — it can never fall into the "+N" overflow', () => {
    // Shown on some self-posted cards and hidden on others, the mark would stop
    // being a statement of origin and start looking like a distinction.
    const code = withoutComments(read(VACANCY_CARD));
    const mark = code.indexOf("t('vacancy.directBadge')");
    const work = code.indexOf('<WorkTypeBadge');
    const cap = code.indexOf('MAX_BADGES');
    expect(mark).toBeGreaterThan(-1);
    expect(mark, 'the mark must be pushed before the overflowing badges').toBeLessThan(work);
    expect(cap).toBeGreaterThan(-1);
  });

  it('«От пользователя» is gone — one mark about one thing', () => {
    expect(keysOf(ru)).not.toContain('vacancy.fromUser');
    expect(keysOf(en)).not.toContain('vacancy.fromUser');
    for (const file of srcFiles()) expect(read(file), file).not.toMatch(/\bfromUser\b/);
  });

  it('`featured` is a server-side word: the client reads it nowhere', () => {
    // The whole point of (1): the mark must not expire with the privilege. The
    // field stays in the wire contract and is named ONLY there.
    for (const file of srcFiles()) {
      if (file !== API_TYPES) {
        expect(withoutComments(read(file)), `${file} reads \`featured\``).not.toMatch(/\bfeatured\b/);
      }
      expect(read(file), `${file} touches a \`featured\` field`).not.toMatch(/\.featured\b/);
    }
    expect(read(API_TYPES), 'the contract must still carry the field').toMatch(/^\s*featured\?: boolean;$/m);
  });

  it('a paid card gets no position from the client — no order, no frame', () => {
    // The refusal of the week to a paid ad lives in the server grant
    // (lib/korea/ads/featured.ts). This is the client half: nothing here sorts,
    // ranks or frames a card by `promo`.
    // src/content/ is excluded on purpose: it is published PROSE, and the posting
    // rules legitimately talk about «промокоды» and «накрутку подписчиков».
    for (const file of srcFiles().filter((p) => !p.includes(join('src', 'content')))) {
      for (const line of withoutComments(read(file)).split('\n')) {
        if (!/promo/i.test(line)) continue;
        expect(line, `${file}: promo may not decide position`).not.toMatch(
          /\bsort\b|\border\b|rank|priority|boost|\bfeatured\b/i,
        );
      }
    }
    expect(read(VACANCY_CARD), 'the card frame is one constant class').toContain(
      '<div className="card" role="button"',
    );
  });
});

describe('free placement: what the person SEES on the open card', () => {
  it('the note is a PLATE with its own icon — not a grey line, not a tick or a shield', () => {
    const gates = gatesOf(VACANCY_SCREEN, "t('vacancy.directNote')");
    expect(gates).toHaveLength(1);
    const plate = gates[0]!.branch;
    expect(plate, 'the same weight on screen as the paid plate').toContain('className="adnote"');
    expect(plate).toContain("t('vacancy.directBadge')"); // the plate NAMES the badge it explains
    expect(plate).toContain('<AuthorIcon');
    expect(plate, 'a megaphone means advertising').not.toContain('IconMegaphone');
    expect(plate, 'a shield means we vouch for it').not.toContain('ShieldIcon');
    expect(plate, 'the tick in this app means "contact opened"').not.toContain('IconCheck');

    const icon = (collect(ast(VACANCY_SCREEN), ts.isFunctionDeclaration) as ts.FunctionDeclaration[]).find(
      (d) => d.name?.text === 'AuthorIcon',
    );
    expect(icon, 'AuthorIcon must exist in this file').toBeTruthy();
    const svg = icon!.getText();
    expect(svg, 'no colour of its own — the plate paints it grey').not.toMatch(/#[0-9a-f]{3,8}\b|green/i);
    expect(svg, 'a person outline, not a mark of approval').toContain('<circle');
  });

  it('the prepayment warning is back, and it is shown for EVERY vacancy', async () => {
    // It was written for exactly this place and quietly stopped being rendered when
    // the trust card arrived; the trust card's own text never says we do not vet
    // employers. For a self-posted ad nothing else on the screen said it at all.
    expect(read(VACANCY_SCREEN)).toContain("t('vacancy.prepayNote')");
    for (const gate of gatesOf(VACANCY_SCREEN, "t('vacancy.prepayNote')")) {
      expect(gate.condition, 'the warning may not depend on the kind of listing').not.toMatch(
        /promo|featured|fromAuthor|source_kind/i,
      );
    }
    expect((await dictionary('ru'))('vacancy.prepayNote')).toContain('не проверяем');
    expect((await dictionary('en'))('vacancy.prepayNote')).toContain('do not vet');
  });

  it('«Реклама» survived the end of payment — the label is law, not a price tag', async () => {
    for (const [lng, label] of [
      ['ru', 'Реклама'],
      ['en', 'Ad'],
    ] as const) {
      const t = await dictionary(lng);
      expect(t('vacancy.adBadge')).toBe(label);
      expect(t('partners.ads.badge')).toBe(label);
    }
    expect(read(VACANCY_CARD)).toContain("t('vacancy.adBadge')");
    expect(read(PARTNERS)).toContain("t('partners.ads.badge')");
    // The paid plate keeps BOTH its title and the sentence that limits our part.
    const plate = gatesOf(VACANCY_SCREEN, "t('partners.ads.disclaimer')")[0]!.branch;
    expect(plate).toContain("t('vacancy.adBadge')");
    expect(plate).toContain('className="adnote"');
  });
});

describe('free placement: the dictionaries say what the screens can draw', () => {
  it('ru and en carry exactly the same keys', () => {
    const [a, b] = [keysOf(ru).sort(), keysOf(en).sort()];
    expect(a.filter((k) => !b.includes(k)), 'in ru only').toEqual([]);
    expect(b.filter((k) => !a.includes(k)), 'in en only').toEqual([]);
  });

  it('the keys that priced a vacancy are gone — from the dictionaries AND from every screen', async () => {
    for (const dict of [keysOf(ru), keysOf(en)]) {
      expect(dict).not.toContain('partners.jobs.payNote');
      expect(dict).not.toContain('partners.jobs.verifyNote');
    }
    // WHY the second half matters: i18next echoes a missing key, so a leftover
    // `t()` call would print the key itself on the screen.
    const t = await dictionary('ru');
    expect(t('partners.jobs.payNote')).toBe('partners.jobs.payNote');
    for (const file of srcFiles()) {
      expect(read(file), file).not.toMatch(/\bpayNote\b/);
      expect(read(file), file).not.toMatch(/\bverifyNote\b/);
    }
  });

  it('«мы не сторона сделки» stays — only the word «Реклама» left the sentence', async () => {
    // The ads card is money transfers and insurance: the highest stakes we carry,
    // and this sentence is the only protection on it. The word itself is not
    // needed inside it — the badge on the same card says it.
    for (const dict of [keysOf(ru), keysOf(en)]) expect(dict).toContain('partners.ads.disclaimer');
    const rus = (await dictionary('ru'))('partners.ads.disclaimer');
    expect(rus).toContain('не сторона сделки');
    expect(rus).not.toContain('Реклама');
    const eng = (await dictionary('en'))('partners.ads.disclaimer');
    expect(eng).toContain('not a party to the deal');
    expect(eng).not.toMatch(/\bad(s|vert\w*)?\b/i);
  });

  it('the marking rule no longer says only PAID placements are marked', async () => {
    // «Не помечено — значит не реклама» has to stay TRUE after payment ended.
    const rus = (await dictionary('ru'))('partners.disclaimer.adsMark');
    expect(rus).not.toMatch(/платн/i);
    expect(rus).toContain('Реклама');
    const eng = (await dictionary('en'))('partners.disclaimer.adsMark');
    expect(eng).not.toMatch(/\bpaid\b/i);
    expect(eng).toMatch(/\bad\b/i);
  });

  it('the Partners card promises a week, names the real badge, and promises nothing else', async () => {
    for (const dict of [keysOf(ru), keysOf(en)]) {
      expect(dict).toContain('partners.jobs.featuredNote');
      expect(dict).toContain('partners.jobs.featuredTerms');
    }
    for (const lng of ['ru', 'en'] as const) {
      const t = await dictionary(lng);
      // The text may only name a badge that really exists, with its real words.
      expect(t('partners.jobs.featuredNote'), lng).toContain(t('vacancy.directBadge'));
    }
    // The limit of the promise lives INSIDE featuredNote — one key, so it cannot be
    // split off and demoted to the fine print.
    expect((await dictionary('ru'))('partners.jobs.featuredNote')).toContain('не обещаем');
    expect((await dictionary('en'))('partners.jobs.featuredNote')).toMatch(/don['’]t promise/i);
    // There is no automatic extension in the code: the text must not promise one.
    const rusTerms = (await dictionary('ru'))('partners.jobs.featuredTerms');
    expect(rusTerms).toContain('напишите нам');
    expect(rusTerms).not.toMatch(/автоматическ/i);
    expect((await dictionary('en'))('partners.jobs.featuredTerms')).toContain('write to us');

    const screen = withoutComments(read(PARTNERS));
    const at = (key: string): number => screen.indexOf(`'${key}'`);
    expect(at('partners.jobs.featuredNote')).toBeGreaterThan(-1);
    expect(at('partners.jobs.featuredNote')).toBeLessThan(at('partners.jobs.featuredTerms'));
    expect(at('partners.jobs.featuredTerms')).toBeLessThan(at('partners.jobs.agencyNote'));
  });
});

describe('placement rules: the words point at a document that exists', () => {
  it('the document has text, in both languages', () => {
    // Red if the file is emptied (and the import itself fails if it is deleted).
    expect(PLACEMENT_RULES.ru.sections.length).toBeGreaterThan(0);
    expect(PLACEMENT_RULES.en.sections.length).toBeGreaterThan(0);
    for (const lng of ['ru', 'en'] as const) {
      expect(PLACEMENT_RULES[lng].intro.length, lng).toBeGreaterThan(20);
      expect(PLACEMENT_RULES[lng].meta, lng).toMatch(/1\.0/);
    }
  });

  it('the screen and the route exist, and every link spells the path once', () => {
    expect(PLACEMENT_RULES_PATH).toBe('/placement-rules');
    const app = withoutComments(read(APP_TSX));
    expect(app).toContain('PLACEMENT_RULES_PATH');
    expect(app).toMatch(/<Route path=\{PLACEMENT_RULES_PATH\.slice\(1\)\} element=\{<PlacementRulesScreen \/>\}/);
    const doc = withoutComments(read(DOC_SCREEN));
    expect(doc).toContain('PLACEMENT_RULES');
    expect(doc).toContain('<LegalDoc');
    expect(doc).toContain("t('placementRules.title')");
    // One spelling of the path: four hand-typed copies is how a link starts
    // leading nowhere while every screen still compiles.
    for (const file of srcFiles()) {
      if (file === PATHS) continue;
      expect(read(file), `${file} spells the path by hand`).not.toContain("'/placement-rules'");
    }
    for (const file of [PARTNERS, POST, OUTSIDE]) {
      expect(withoutComments(read(file)), file).toContain('PLACEMENT_RULES_PATH');
    }
  });

  it('the posting form links the document from the sentence that accepts it', async () => {
    for (const lng of ['ru', 'en'] as const) {
      const value = (await dictionary(lng))('post.consent');
      expect(value.match(/<rules>/g), lng).toHaveLength(1);
      expect(value.match(/<\/rules>/g), lng).toHaveLength(1);
    }
    const post = withoutComments(read(POST));
    expect(post).toContain('i18nKey="post.consent"');
    expect(post).toMatch(/rules: <Link className="consent__link" to=\{PLACEMENT_RULES_PATH\} \/>/);
  });

  it('«правила размещения» in the Partners note is the link, not plain words', async () => {
    // The link is made of the document's OWN title, lowercased — the exact words
    // already standing in the sentence. If either text drifts, this goes red
    // instead of the note silently losing its link.
    for (const lng of ['ru', 'en'] as const) {
      const t = await dictionary(lng);
      const phrase = t('placementRules.title').toLowerCase();
      const terms = t('partners.jobs.featuredTerms').toLowerCase();
      expect(terms.split(phrase).length - 1, `${lng}: «${phrase}» in featuredTerms`).toBe(1);
    }
    const partners = withoutComments(read(PARTNERS));
    expect(partners).toContain('<NoteWithRules');
    expect(partners).toContain("phrase={t('placementRules.title')}");
    expect(partners).toContain("text={t('partners.jobs.featuredTerms')}");
  });

  it('the plain-browser page offers it next to the other two documents', () => {
    const outside = withoutComments(read(OUTSIDE));
    expect(outside).toContain("t('placementRules.title')");
    expect(outside).toContain('PLACEMENT_RULES[lang]');
    expect(outside).toMatch(/startsWith\(PLACEMENT_RULES_PATH\)/);
  });
});

describe('posting form: the "no money upfront" confirmation', () => {
  it('both ticks are required before anything can be published', () => {
    const code = withoutComments(read(POST));
    expect(code).toMatch(/return consent && noFee;/);
    // Not restored from storage: it is a statement about THIS listing, and a tick
    // rehydrated from a previous ad is a confirmation nobody gave this time.
    expect(code).toMatch(/const \[noFee, setNoFee\] = useState\(false\)/);
    expect(code).toContain("t('post.noFeeCheck')");
    expect(code).toContain("t('post.noFeeHint')");
  });

  it('the flag travels under the name the backend actually reads, on CREATE only', () => {
    // Checked against the backend CODE, not a report: lib/korea/ads/input.ts reads
    // `no_worker_fee` and rw.ts refuses a create without it (400). The edit path
    // (ads/manage.ts) never asks, and a PATCH carrying `false` would read as a
    // withdrawal of a confirmation that was in fact given.
    const code = withoutComments(read(POST));
    expect(code).toMatch(/\.\.\.\(editingId \? \{\} : \{ no_worker_fee: noFee \}\)/);
    expect(read(API_TYPES)).toMatch(/^\s*no_worker_fee\?: boolean;$/m);
  });

  it('the tick stays NARROW — it may not contradict the fee field of the same form', async () => {
    // The form lets the author declare «Комиссия за трудоустройство: Платно», and
    // the safety screen says a salary commission «берут часто». Only payment
    // UPFRONT is ours to ask about (owner, 21.10.2026).
    expect((await dictionary('ru'))('post.noFeeCheck')).toContain('вперёд');
    expect((await dictionary('en'))('post.noFeeCheck')).toContain('upfront');
  });

  it('the Partners promise is no wider than the tick it rests on', async () => {
    // Three places must say the same thing — the partnership card, the tick, and
    // section 5 of the placement rules. A promise wider than the confirmation given
    // is one we could not enforce without breaking our own text.
    for (const [lng, narrow] of [
      ['ru', 'вперёд'],
      ['en', 'upfront'],
    ] as const) {
      const t = await dictionary(lng);
      expect(t('post.noFeeCheck'), lng).toContain(narrow);
      expect(t('partners.jobs.agencyNote'), `${lng}: the promise stays as narrow as the tick`).toContain(narrow);
    }
  });

  it('the refusal about the tick gets its OWN answer, not "check your connection"', () => {
    // The detail exists precisely so the app can tell this refusal apart. Compared
    // with the literal in the BACKEND source: if either side renames it this goes
    // red, instead of the author being sent off to fix his internet.
    const DETAIL = 'no_worker_fee_confirmation_required';
    const server = readFileSync(resolve(APP, '..', 'lib/korea/ads/rw.ts'), 'utf8');
    expect(server, 'the backend no longer answers with this detail').toContain(`'${DETAIL}'`);

    const code = withoutComments(read(POST));
    expect(code).toContain(DETAIL);
    expect(code).toContain("t('post.noFeeRequired')");
    // …and it must answer BEFORE the generic paths, or the special answer never shows.
    expect(code.indexOf(DETAIL)).toBeLessThan(code.indexOf("t('post.reject.network')"));
    for (const dict of [keysOf(ru), keysOf(en)]) expect(dict).toContain('post.noFeeRequired');
  });
});

describe('partners: a chip may not promise a format that no longer exists', () => {
  /** The `<PartnerCard …>` element containing `needle`, as source text. */
  function cardWith(needle: string): string {
    const cards = collect(
      ast(PARTNERS),
      (n) => ts.isJsxElement(n) && n.openingElement.tagName.getText() === 'PartnerCard',
    ) as ts.JsxElement[];
    const found = cards.filter((c) => c.getText().includes(needle));
    expect(found, `exactly one PartnerCard must contain ${needle}`).toHaveLength(1);
    return found[0]!.getText();
  }

  it('the vacancies card carries no «Обсудим формат» — the week is the same for everyone', () => {
    expect(cardWith("t('partners.jobs.title')")).not.toContain('discussFormat');
  });

  it('the other cards keep theirs — the chip was made optional, not deleted', () => {
    expect(cardWith("t('partners.ads.title')")).toContain('discussFormat');
    expect(withoutComments(read(PARTNERS))).toContain('footLabel?: string;');
    expect(withoutComments(read(PARTNERS)), 'an absent label draws no empty chip').toMatch(/\{footLabel \? \(/);
  });
});
