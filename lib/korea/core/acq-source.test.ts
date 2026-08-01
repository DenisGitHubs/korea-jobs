// lib/korea/core/acq-source.test.ts
//
// THE GATE between a deep-link label and users.acq_source. `startapp` is a public URL tail —
// anybody can open t.me/korea_rabota_bot/app?startapp=s_whatever — and the label deliberately
// SURVIVES account erasure, so "well-formed" was never enough: from 02.08.2026 a label is stored
// only if the owner approved it in config.acq_sources_allowed. What is pinned here:
//
//   * approved label -> stored; anything else -> NULL + a counted (never stored) rejection;
//   * FAIL-CLOSED: no key / empty list / all-junk list -> nothing is ever labelled;
//   * the list is normalized with the SAME rules as the incoming label (case, dash -> underscore),
//     otherwise the owner writes ADS_RU1 in the list and silently nothing matches;
//   * a label-less visit never even reads the config (no extra DB hit on the hot auth path);
//   * a label added to the list starts working within the 60-second config cache — no deploy.
//
// The REAL config reader is exercised (only the DB is faked), because the chain that actually
// breaks in production is "jsonb value -> allowed set", not the comparison itself.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    /** jsonb value stored under 'acq_sources_allowed'; undefined = the key does not exist. */
    allowed: undefined as unknown,
    /** Query texts (whitespace-collapsed) in call order. */
    queries: [] as string[],
    /** When true, every statement rejects (DB blip / table not migrated yet). */
    dbBroken: false,
  };
  const fakeSql = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const q = strings.join(' ? ').replace(/\s+/g, ' ').trim();
    state.queries.push(q);
    void values;
    if (state.dbBroken) return Promise.reject(new Error('db is down'));
    if (q.includes('from config')) {
      return Promise.resolve(
        state.allowed === undefined ? [] : [{ key: 'acq_sources_allowed', value: state.allowed }],
      );
    }
    return Promise.resolve([]);
  };
  return { state, fakeSql };
});

vi.mock('./db.js', () => ({ getSql: () => h.fakeSql }));

import {
  getAllowedAcqSources,
  resolveAcqSource,
  noteAcqRejectBestEffort,
  ACQ_ALLOWLIST_KEY,
} from './acq-source.js';
import { __resetConfigForTests } from '../config.js';

beforeEach(() => {
  h.state.allowed = undefined;
  h.state.queries = [];
  h.state.dbBroken = false;
  __resetConfigForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

const configReads = (): number => h.state.queries.filter((q) => q.includes('from config')).length;

describe('getAllowedAcqSources — what the owner approved', () => {
  it('reads the documented shape: a jsonb array of strings', async () => {
    h.state.allowed = ['ads_ru1', 'ads_ru2', 'ads_uz1', 'ads_uz2'];
    expect(await getAllowedAcqSources()).toEqual(['ads_ru1', 'ads_ru2', 'ads_uz1', 'ads_uz2']);
  });

  it('normalizes entries exactly like an incoming label (case + dash inside the slug)', async () => {
    h.state.allowed = ['ADS_RU1', 'ads_uz-1'];
    expect(await getAllowedAcqSources()).toEqual(['ads_ru1', 'ads_uz_1']);
  });

  it('follows the PARSER, not its own idea of a label: no underscore after the prefix = junk', async () => {
    // `ads-ru1` is not a legal label for an incoming link either (SOURCE_RE demands `ads_`/`s_`),
    // so it must not become a phantom entry that matches nothing. Dropped -> absent from the
    // /stats echo -> the owner sees that this line of his list did not take.
    h.state.allowed = ['ads-ru1', 'ads_ru1'];
    expect(await getAllowedAcqSources()).toEqual(['ads_ru1']);
  });

  it('accepts a whole pasted link — he copies what he put into the ad cabinet', async () => {
    h.state.allowed = ['https://t.me/korea_rabota_bot/app?startapp=ads_ru3'];
    expect(await getAllowedAcqSources()).toEqual(['ads_ru3']);
  });

  it('tolerates one comma-separated string instead of an array', async () => {
    h.state.allowed = 'ads_ru1, ads_uz1';
    expect(await getAllowedAcqSources()).toEqual(['ads_ru1', 'ads_uz1']);
  });

  it('drops entries that are not legal labels and de-duplicates the rest', async () => {
    h.state.allowed = ['ads_ru1', 'ADS_RU1', 'реклама', 'nopfx', 'ads_', 42, '', '   '];
    expect(await getAllowedAcqSources()).toEqual(['ads_ru1']);
  });

  it.each([
    ['the key does not exist', undefined],
    ['an empty array', []],
    ['a list of nothing but junk', ['реклама', 'nopfx']],
    ['a number', 7],
    ['an object', { ads_ru1: true }],
  ])('%s -> empty list (fail-closed)', async (_label, value) => {
    h.state.allowed = value;
    expect(await getAllowedAcqSources()).toEqual([]);
  });
});

describe('resolveAcqSource — the only decision that reaches users.acq_source', () => {
  it('stores an approved label', async () => {
    h.state.allowed = ['ads_ru1', 'ads_uz1'];
    expect(await resolveAcqSource('ads_ru1')).toEqual({ source: 'ads_ru1', rejected: false });
  });

  it('matches regardless of case/dash on EITHER side', async () => {
    // The list is written one way, the ad cabinet another — both fold to the same canonical form.
    h.state.allowed = ['ADS_RU-1'];
    expect(await resolveAcqSource('ads_ru_1')).toEqual({ source: 'ads_ru_1', rejected: false });
    expect(await resolveAcqSource('ADS_RU-1')).toEqual({ source: 'ads_ru_1', rejected: false });
    expect(await resolveAcqSource('ads_ru-1')).toEqual({ source: 'ads_ru_1', rejected: false });
  });

  it('REFUSES a well-formed label that nobody approved (the hole being closed)', async () => {
    h.state.allowed = ['ads_ru1'];
    // A stranger inventing a label about himself: shaped fine, meaning unapproved.
    expect(await resolveAcqSource('s_ivan_petrov_seoul')).toEqual({ source: null, rejected: true });
    // A typo in the ad cabinet looks exactly the same from here.
    expect(await resolveAcqSource('ads_ru11')).toEqual({ source: null, rejected: true });
  });

  it('refuses a label that describes a PERSON, not a channel (special-category data)', async () => {
    h.state.allowed = ['ads_ru1', 'ads_uz1'];
    for (const bad of ['s_uzbeki', 'ads_nelegaly', 's_bez_viz']) {
      expect(await resolveAcqSource(bad)).toEqual({ source: null, rejected: true });
    }
  });

  it('a broken config read is fail-closed too, and never throws at the caller', async () => {
    // The auth path awaits this: a thrown error there would turn a paid click into a locked door.
    h.state.allowed = ['ads_ru1'];
    h.state.dbBroken = true;
    await expect(resolveAcqSource('ads_ru1')).resolves.toEqual({ source: null, rejected: true });
  });

  it('with an empty / missing list NOTHING is stored, and the attempt is counted', async () => {
    h.state.allowed = [];
    expect(await resolveAcqSource('ads_ru1')).toEqual({ source: null, rejected: true });
    __resetConfigForTests();
    h.state.allowed = undefined;
    expect(await resolveAcqSource('ads_ru1')).toEqual({ source: null, rejected: true });
  });

  it.each([
    ['nothing', null],
    ['empty', ''],
    ['a bare referral code', 'a1b2c3d4e5f60718'],
    ['a vacancy share', 'v0f8c2a1b3d4e4f5a6b7c8d9e0f1a2b3c'],
    ['junk', 'not-a-label'],
    ['a bare prefix', 'ads_'],
  ])('%s is not a label at all: no source, and NOT a rejection', async (_l, input) => {
    h.state.allowed = ['ads_ru1'];
    expect(await resolveAcqSource(input as string | null)).toEqual({ source: null, rejected: false });
  });

  it('does not touch the config when there is no label (hot path stays one round-trip)', async () => {
    h.state.allowed = ['ads_ru1'];
    await resolveAcqSource(null);
    await resolveAcqSource('a1b2c3d4e5f60718');
    await resolveAcqSource('');
    expect(configReads()).toBe(0);
  });

  it('reads the config once per cache window, not once per visitor', async () => {
    h.state.allowed = ['ads_ru1'];
    await resolveAcqSource('ads_ru1');
    await resolveAcqSource('ads_ru1');
    await resolveAcqSource('ads_ru1');
    expect(configReads()).toBe(1);
  });

  it('a label ADDED to the list starts counting without a deploy (60-second cache)', async () => {
    vi.useFakeTimers();
    h.state.allowed = ['ads_ru1'];
    expect(await resolveAcqSource('ads_ru3')).toEqual({ source: null, rejected: true });

    // The owner edits config in the console — no restart, no deploy.
    h.state.allowed = ['ads_ru1', 'ads_ru3'];
    vi.advanceTimersByTime(61_000);

    expect(await resolveAcqSource('ads_ru3')).toEqual({ source: 'ads_ru3', rejected: false });
  });

  it('the config key is the one the migration seeds', () => {
    expect(ACQ_ALLOWLIST_KEY).toBe('acq_sources_allowed');
  });
});

describe('noteAcqRejectBestEffort — count, never store', () => {
  it('increments one row per Seoul day and binds no value at all', async () => {
    await noteAcqRejectBestEffort(h.fakeSql as never);
    const q = h.state.queries.at(-1)!;
    expect(q).toContain('insert into acq_rejects');
    expect(q).toContain("(now() at time zone 'Asia/Seoul')::date");
    expect(q).toContain('on conflict (day) do update set n = acq_rejects.n + 1');
    // The statement mentions no column that could hold the rejected string or a user.
    expect(q).not.toContain('user');
    expect(q).not.toContain('source');
  });

  it('swallows a DB fault — bookkeeping must never block a login', async () => {
    h.state.dbBroken = true;
    await expect(noteAcqRejectBestEffort(h.fakeSql as never)).resolves.toBeUndefined();
  });
});
