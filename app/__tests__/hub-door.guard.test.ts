/**
 * Guards for the AppHub Studio door (frontend half).
 *
 * The hand-off ticket arrives in the URL fragment and must be taken out of the
 * address bar by OUR code, before anything else on the page runs. That promise
 * rests on four things that are easy to break by accident and impossible to
 * notice afterwards — so each one is nailed down here, as text, in the files
 * where a regression would actually live.
 *
 * These are source guards on purpose: the properties they protect (load order,
 * "no other script on the page", "the CSP that keeps it that way") are not
 * observable from a unit test of the module itself.
 *
 * The app has no test runner of its own; this file lives in the ROOT vitest set
 * (`npx vitest run` from the project root picks it up by the default include).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import ts from 'typescript';
import { hubEntry, hubFailure, hubSessionLost, watchHubSession } from '../src/lib/hubGate';
import { ru } from '../src/i18n/ru';
import { en } from '../src/i18n/en';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(APP, '..');

const INDEX_HTML = resolve(APP, 'index.html');
const MAIN_TSX = resolve(APP, 'src/main.tsx');
const HUB_TICKET_TS = resolve(APP, 'src/lib/hubTicket.ts');
const LAUNCH_ENV_TS = resolve(APP, 'src/lib/launchEnv.ts');
const CLIENT_TS = resolve(APP, 'src/shared/api/client.ts');
const HUB_GATE_TS = resolve(APP, 'src/lib/hubGate.ts');
const HUB_DOWN_TSX = resolve(APP, 'src/components/HubDown.tsx');
const HUB_EXPIRED_TSX = resolve(APP, 'src/components/HubExpired.tsx');
const SETTINGS_TSX = resolve(APP, 'src/screens/SettingsScreen.tsx');
// Both configs carry the same header block; the root one is what ships (the
// root vercel.json builds app/ and serves app/dist).
const VERCEL_JSON = [resolve(ROOT, 'vercel.json'), resolve(APP, 'vercel.json')];

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

/**
 * Strip comments before looking for a REQUIRED line: otherwise a guard happily
 * finds its own needle quoted in a comment and passes over deleted code.
 * (Forbidden strings are checked against the full source instead — stricter.)
 */
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Parse a source file for real, instead of pattern-matching its text.
 *
 * ORDER inside a callback and WHICH branch renders WHICH screen are the two
 * things guarded below, and a regexp can only ever recognise the shapes its
 * author happened to think of — the next legal way of writing the same code
 * slips past it silently (skill: a rule that judges code reads the tree).
 * `setParentNodes` is on so a matched node can be asked for its text and its
 * surrounding block.
 */
function ast(file: string): ts.SourceFile {
  return ts.createSourceFile(file, read(file), ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
}

/** Every node satisfying `pred`, in source order (pre-order walk). */
function collect(node: ts.Node, pred: (n: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = [];
  const walk = (n: ts.Node): void => {
    if (pred(n)) found.push(n);
    n.forEachChild(walk);
  };
  walk(node);
  return found;
}

/** `foo()` -> "foo", `root.render()` -> "root.render", anything else -> "". */
function calleeName(call: ts.CallExpression): string {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return `${e.expression.getText()}.${e.name.text}`;
  return '';
}

/** Names of the calls inside `node`, in the order they are written. */
function callNames(node: ts.Node): string[] {
  return (collect(node, ts.isCallExpression) as ts.CallExpression[]).map(calleeName);
}

/** A sessionStorage stand-in: node has none, and the pass must be checked in a STORE. */
function fakeSessionStorage(): Storage & { has(key: string): boolean } {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    has: (k: string) => map.has(k),
  };
}

/** The real i18next, loaded with the real dictionaries — what the person reads. */
async function dictionary(lng: 'ru' | 'en'): Promise<(key: string, vars?: object) => string> {
  const i18n = i18next.createInstance();
  await i18n.init({
    resources: { ru: { translation: ru }, en: { translation: en } },
    lng,
    fallbackLng: 'ru',
    interpolation: { escapeValue: false },
  });
  return (key: string, vars?: object) => String(i18n.t(key, vars ?? {}));
}

interface VercelHeader {
  key: string;
  value: string;
}

function cspOf(file: string): string {
  const cfg = JSON.parse(read(file)) as { headers?: { headers?: VercelHeader[] }[] };
  const all = (cfg.headers ?? []).flatMap((h) => h.headers ?? []);
  const csp = all.find((h) => h.key.toLowerCase() === 'content-security-policy');
  if (!csp) throw new Error(`no Content-Security-Policy header in ${file}`);
  return csp.value;
}

/** Sources listed for one CSP directive, e.g. script-src -> ["'self'"]. */
function directive(csp: string, name: string): string[] {
  const part = csp
    .split(';')
    .map((s) => s.trim())
    .find((s) => s === name || s.startsWith(`${name} `));
  return part ? part.split(/\s+/).slice(1) : [];
}

describe('hub door: nothing may run before we take the ticket out of the URL', () => {
  it('index.html loads exactly one script, and it is /src/main.tsx', () => {
    // A second <script> tag — inline or a vendor file — could execute before our
    // entry module and read the ticket straight out of location.hash.
    const tags = read(INDEX_HTML).match(/<script\b[^>]*>/gi) ?? [];
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatch(/\bsrc\s*=\s*"\/src\/main\.tsx"/);
  });

  it("CSP script-src is exactly 'self' — no unsafe-inline, no foreign hosts", () => {
    // This is the other half of the guard above: the single-script rule only
    // holds while the policy forbids inline code and third-party origins.
    for (const file of VERCEL_JSON) {
      const sources = directive(cspOf(file), 'script-src');
      expect(sources, file).toEqual(["'self'"]);
    }
  });

  it("the first import in main.tsx is './lib/hubTicket'", () => {
    const first = read(MAIN_TSX).match(/^[ \t]*import\b.*$/m);
    expect(first).toBeTruthy();
    expect(first?.[0].trim()).toBe("import './lib/hubTicket';");
  });
});

describe('hub door: the ticket leaves no trace', () => {
  it('hubTicket.ts never logs and never touches persistent site storage', () => {
    // Checked against the FULL source, comments included: the ticket must not
    // appear in a console line or outlive the tab, and a mention in a comment is
    // a strong enough smell to fail on.
    const src = read(HUB_TICKET_TS);
    expect(src).not.toMatch(/console\s*\./);
    expect(src).not.toMatch(/\blocalStorage\b/);
  });

  it('hubTicket.ts wipes the fragment with history.replaceState', () => {
    const code = withoutComments(read(HUB_TICKET_TS));
    expect(code).toMatch(/history\s*\.\s*replaceState\s*\(/);
  });
});

describe('hub door: the pass may not be carried to a foreign origin', () => {
  it("CSP connect-src is exactly 'self' — nothing may be sent anywhere else", () => {
    // script-src 'self' stops a classic XSS, but not the vector that actually
    // matters here: ONE poisoned dependency ships inside our own bundle, counts
    // as a 'self' script, reads the day-long bearer pass out of sessionStorage
    // and posts it wherever it likes. `connect-src 'self' https:` permitted
    // exactly that. Narrowed to 'self' in BOTH configs: the API is same-origin
    // (REAL_BASE = VITE_API_BASE_URL || '/api', and the variable is unset in
    // production), and every https://t.me address in the app is a navigation
    // (window.open / href), which connect-src does not govern.
    //
    // This guard is also the alarm for the day someone points the API at
    // another origin through VITE_API_BASE_URL: it breaks LOUDLY here instead
    // of silently in a browser console.
    for (const file of VERCEL_JSON) {
      const sources = directive(cspOf(file), 'connect-src');
      expect(sources, file).toEqual(["'self'"]);
    }
  });
});

describe('hub door: a refusal must not send people to "Open in Telegram"', () => {
  // The backend separates "this deployment has no hub key" (503) from "this
  // ticket is no good" (401) — four backend tests cover it. The frontend used
  // to throw that apart away in one catch: any refusal rendered the landing
  // page, whose whole content is a t.me link that may not even open inside the
  // shell's window. These lock the split in.
  it('our own side failing is retryable — 503, 5xx and a dead network all mean "down"', () => {
    expect(hubFailure(503)).toBe('down');
    expect(hubFailure(500)).toBe('down');
    expect(hubFailure(502)).toBe('down');
    expect(hubFailure(undefined)).toBe('down'); // no status at all: network/DNS/abort
  });

  it('a refused ticket is terminal — 4xx means "expired", never "try again"', () => {
    expect(hubFailure(401)).toBe('expired');
    expect(hubFailure(403)).toBe('expired');
    expect(hubFailure(400)).toBe('expired');
    expect(hubFailure(404)).toBe('expired');
  });

  it('no pass and no ticket opens the "sign-in expired" screen, not the landing page', () => {
    expect(hubEntry(false, false)).toBe('expired');
    expect(hubEntry(false, true)).toBe('exchange');
    expect(hubEntry(true, false)).toBe('app');
    expect(hubEntry(true, true)).toBe('app'); // a live pass always wins
  });

  it('main.tsx renders OutsideTelegram on exactly one line, the plain-browser one', () => {
    const lines = withoutComments(read(MAIN_TSX))
      .split('\n')
      .filter((l) => l.includes('<OutsideTelegram'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('outside ?');
  });

  it('main.tsx maps the two failures to their own screens', () => {
    const code = withoutComments(read(MAIN_TSX));
    expect(code).toMatch(/<HubDown\b/);
    expect(code).toMatch(/<HubExpired\b/);
  });
});

describe('hub door: a dead pass gets one honest screen, not a silent app', () => {
  it('the session watcher fires once and only once', () => {
    // Several requests are normally in flight together; they come back 401 as a
    // group. The visitor must get ONE screen, not a stampede of re-renders.
    let fired = 0;
    watchHubSession(() => {
      fired += 1;
    });
    hubSessionLost();
    hubSessionLost();
    hubSessionLost();
    expect(fired).toBe(1);
  });

  it('nobody subscribed means nothing happens (the Telegram way in is untouched)', () => {
    watchHubSession(null);
    expect(() => hubSessionLost()).not.toThrow();
  });

  it('the api client reports a 401 through hubGate — in ONE place, not per screen', () => {
    const code = withoutComments(read(CLIENT_TS));
    expect(code).toMatch(/res\.status === 401/);
    expect(code).toMatch(/hubSessionLost\(\)/);
  });

  it('a hub tab stays a hub tab after its pass dies (launchEnv reads the mark)', () => {
    // Without this the reload after an expired pass looks like a stranger's
    // browser and lands on the landing page — the dead end again.
    const code = withoutComments(read(LAUNCH_ENV_TS));
    const hubLine = code.split('\n').find((l) => l.includes("return 'hub'"));
    expect(hubLine).toBeTruthy();
    expect(hubLine).toContain('isHubTab()');
  });
});

describe('hub door: what the person actually READS', () => {
  // A guard on the wiring is only half the job: the owner's rule is that a
  // decision has arrived when a HUMAN SEES it. So the dictionaries are put
  // through the real i18next, with the real keys the screens ask for.
  it('both languages render the two screens — and the app name, not "{{app}}"', async () => {
    const i18n = i18next.createInstance();
    await i18n.init({
      resources: { ru: { translation: ru }, en: { translation: en } },
      lng: 'ru',
      fallbackLng: 'ru',
      interpolation: { escapeValue: false },
    });

    for (const lng of ['ru', 'en'] as const) {
      await i18n.changeLanguage(lng);
      const t = i18n.t.bind(i18n);
      // Service down: a title, a line that takes the blame off the visitor, and
      // a button — plus `common.close` for the other screen, which reuses it.
      for (const key of ['hub.down.title', 'hub.down.lead', 'hub.down.retry', 'hub.expired.title', 'common.close']) {
        expect(t(key), `${lng} ${key}`).not.toBe(key); // i18next echoes a MISSING key
        expect(String(t(key)).trim().length, `${lng} ${key}`).toBeGreaterThan(0);
      }
      // Sign-in expired: the app name must be interpolated in, so it can never
      // drift from the real one — and the placeholder must not reach the screen.
      const lead = String(t('hub.expired.lead', { app: t('app.title') }));
      expect(lead, lng).toContain(String(t('app.title')));
      expect(lead, lng).not.toContain('{{');
      // The mailing note names the bot, in both languages.
      expect(String(t('settings.notifyBotHint')).length, lng).toBeGreaterThan(20);
      expect(String(t('settings.notifyBotCta')), lng).not.toBe('settings.notifyBotCta');
    }
  });
});

describe('settings: a toggle may not promise messages the bot cannot send', () => {
  it('the note hangs on an explicit false, never on an unknown', () => {
    // `allows_write_to_pm` has THREE states: true, false and absent. Only the
    // explicit false may put the note on screen — an unknown must stay silent.
    const code = withoutComments(read(SETTINGS_TSX));
    expect(code).toMatch(/allowsWriteToPm === false/);
    expect(code).toMatch(/settings\.notifyBotHint/);
    expect(code).toMatch(/settings\.notifyBotCta/);
  });

  it('the toggles themselves are never disabled — subscribing ahead of time is allowed', () => {
    const code = withoutComments(read(SETTINGS_TSX));
    expect(code).not.toMatch(/<Switch[^>]*\bdisabled\b/);
  });
});

describe('hub door: a dead pass is THROWN AWAY, not just hidden behind a screen', () => {
  // The screen alone was not enough. Storage drops a pass by its OWN expires_at
  // and by nothing else, so a pass the server has REVOKED — date still in the
  // future — stayed in the tab: it kept riding along in the `Authorization: kjs`
  // header of every later request, and a reload read it as a live pass, mounted
  // the whole app and walked into the next 401. One F5 back to the broken app.
  const PASS_KEY = 'kj/hub-pass'; // the literal, on purpose: it is the thing to be gone
  const TAB_KEY = 'kj/hub-tab';

  it('a pass whose date is still good is removed by clearHubPass — the store keeps nothing', async () => {
    const store = fakeSessionStorage();
    vi.stubGlobal('sessionStorage', store);
    try {
      const { clearHubPass, readLiveHubPass, writeHubPass } = await import('../src/lib/hubTicket');
      // An hour of life left: the "revoked but not expired" pass, the class the
      // server-side kill switch created.
      writeHubPass({ token: 'pass-for-the-test', expires_at: Math.floor(Date.now() / 1000) + 3600 });
      expect(store.has(PASS_KEY), 'a written pass must be in the store to begin with').toBe(true);
      // Proof that time will NOT clean this one up: it still reads as live.
      expect(readLiveHubPass()).not.toBeNull();

      clearHubPass();

      expect(store.has(PASS_KEY), 'the dead pass is still in sessionStorage').toBe(false);
      expect(readLiveHubPass()).toBeNull();
      // …but the tab stays a shell tab: that mark is what keeps the honest
      // "sign-in expired" screen (and not the "open in Telegram" dead end) after
      // a reload. Dropping it here would undo the earlier fix.
      expect(store.has(TAB_KEY), 'the hub tab mark must survive the pass').toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the hub watcher drops the pass BEFORE it draws the screen', () => {
    // Order is the whole point: while the screen is up the app makes no requests,
    // but the tab lives on and a reload must not find a usable pass.
    const subscriptions = collect(ast(MAIN_TSX), (n) => ts.isCallExpression(n) && calleeName(n) === 'watchHubSession');
    expect(subscriptions, 'main.tsx must subscribe in exactly one place').toHaveLength(1);
    const callback = (subscriptions[0] as ts.CallExpression).arguments[0];
    expect(callback && ts.isArrowFunction(callback)).toBe(true);
    const body = (callback as ts.ArrowFunction).body;

    const names = callNames(body);
    expect(names, 'the watcher must clear the pass').toContain('clearHubPass');
    expect(names, 'the watcher must render the screen').toContain('root.render');
    expect(names.indexOf('clearHubPass')).toBeLessThan(names.indexOf('root.render'));
    expect(body.getText()).toContain('<HubExpired');
  });

  it('hubGate.ts still imports nothing — the decisions stay testable', () => {
    // The clearing belongs to the boot code for this reason: the moment hubGate
    // reaches for storage it drags in window, and the rules of the door can no
    // longer be tested here at all.
    expect(collect(ast(HUB_GATE_TS), ts.isImportDeclaration)).toHaveLength(0);
  });
});

describe('hub door: a fault on OUR side is not a dead sign-in (5xx is not 401)', () => {
  // The backend answers 5xx when OUR side broke (no hub key, the database refused
  // a write) and 401 only when the caller's own credential is no good. A person
  // who reads "sign-in expired" after a database hiccup goes back to the shell,
  // gets a fresh ticket, and lands in the same place — a loop, with nothing he
  // can do about it. These pin the frontend half of that split.

  it('a 500 during the exchange opens the "service is down" screen, not the expired one', async () => {
    // hubFailure() decides…
    expect(hubFailure(500)).toBe('down');
    // …and main.tsx must send that decision to the screen that matches it.
    const src = ast(MAIN_TSX);
    const branch = (collect(src, ts.isIfStatement) as ts.IfStatement[]).find(
      (s) => s.expression.getText().replace(/\s+/g, '') === "outcome==='down'",
    );
    expect(branch, "main.tsx has no `if (outcome === 'down')` branch").toBeTruthy();
    // Comments stripped: the branch EXPLAINS in prose where a spent ticket goes
    // next, and a guard that read prose as code would fail on the explanation.
    const drawn = withoutComments((branch as ts.IfStatement).thenStatement.getText());
    expect(drawn).toContain('<HubDown');
    expect(drawn).not.toContain('<HubExpired');
    // The terminal screen stays the LAST word of that chain — i.e. the 4xx case.
    const block = (branch as ts.IfStatement).parent;
    expect(ts.isBlock(block)).toBe(true);
    const statements = (block as ts.Block).statements;
    expect(statements[statements.length - 1]?.getText()).toContain('<HubExpired');

    // And what the person actually reads on each of the two — different sentences,
    // in Katya's words (change the dictionary deliberately and this line with it).
    const t = await dictionary('ru');
    expect(read(HUB_DOWN_TSX)).toContain("t('hub.down.title')");
    expect(read(HUB_EXPIRED_TSX)).toContain("t('hub.expired.title')");
    expect(t('hub.down.title')).toBe('Сервис временно не работает');
    expect(t('hub.expired.title')).toBe('Вход устарел');
    // Only the "down" screen offers a way forward; the terminal one has no retry.
    expect(read(HUB_DOWN_TSX)).toContain("t('hub.down.retry')");
    expect(read(HUB_EXPIRED_TSX)).not.toContain('hub.down.retry');
  });

  it('a mounted app that gets a 5xx keeps its ordinary error strip — nobody is thrown out', async () => {
    // The real client, the real 401 wiring, a stubbed network. If the status test
    // in client.ts is ever widened past 401, this goes red: a database hiccup
    // would otherwise replace the whole app with "sign-in expired".
    const { api, ApiError } = await import('../src/shared/api/client');
    let lost = 0;
    watchHubSession(() => {
      lost += 1;
    });
    try {
      for (const status of [500, 502, 503]) {
        vi.stubGlobal(
          'fetch',
          async () => ({ ok: false, status, json: async () => ({ error: 'internal' }) }) as unknown as Response,
        );
        await expect(api.me()).rejects.toBeInstanceOf(ApiError);
      }
      expect(lost, 'a 5xx must not retire the session').toBe(0);
    } finally {
      vi.unstubAllGlobals();
      watchHubSession(null);
    }
  });

  it('a 401 — and only a 401 — retires the session', async () => {
    const { api } = await import('../src/shared/api/client');
    let lost = 0;
    watchHubSession(() => {
      lost += 1;
    });
    try {
      vi.stubGlobal(
        'fetch',
        async () => ({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) }) as unknown as Response,
      );
      await expect(api.me()).rejects.toThrow();
      await expect(api.me()).rejects.toThrow(); // a second 401 must not re-render
      expect(lost).toBe(1);
    } finally {
      vi.unstubAllGlobals();
      watchHubSession(null);
    }
  });
});
