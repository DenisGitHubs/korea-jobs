// lib/korea/admin/stats.test.ts
//
// The owner's /stats report. Focus of this file: the ACQUISITION block («откуда пришли») added
// with users.acq_source (draft_0031) — the only way the owner can tell whether a paid Telegram
// Ads campaign brought anybody. What is pinned:
//
//   * gatherStats groups by label and counts total + last 7 days;
//   * a missing column (deploy landed before the migration) degrades to "no block", never to a
//     broken report — every other number must still arrive;
//   * renderStats prints plain Russian the owner can read, distinguishes «пока никто» (the
//     feature is live, nobody came) from «блока нет» (not deployed yet), and counts people with
//     correct grammar.
//
// Everything else in the report is covered incidentally (the render must not lose its old lines).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    /** rows the acq_source group-by returns. */
    sourceRows: [] as Record<string, unknown>[],
    /** true = users.acq_source does not exist yet. */
    noAcqColumn: false,
    queries: [] as string[],
  };
  const fakeSql = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const q = strings.join(' ? ').replace(/\s+/g, ' ').trim();
    state.queries.push(q);
    void values;
    if (q.includes('acq_source')) {
      return state.noAcqColumn
        ? Promise.reject(new Error('column "acq_source" does not exist'))
        : Promise.resolve(state.sourceRows);
    }
    if (q.includes('as new_24h')) {
      return Promise.resolve([
        {
          total: 100, new_24h: 5, new_7d: 20, active_24h: 30, active_7d: 60,
          pm_ok: 80, blocked: 2, referred: 7,
        },
      ]);
    }
    if (q.includes('as vacancies')) {
      return Promise.resolve([{ vacancies: 40, ads_approved: 3, ads_pending: 1, unverified: 9 }]);
    }
    if (q.includes('from ai_usage')) {
      return Promise.resolve([
        {
          calls_24h: 10, colds_24h: 1, in_24h: 1000, out_24h: 200, cread_24h: 500, cwrite_24h: 100,
          in_30d: 5000, out_30d: 1000, cread_30d: 2000, cwrite_30d: 300,
        },
      ]);
    }
    if (q.includes('from raw_messages')) return Promise.resolve([{ processed_24h: 50, pre_ai_24h: 20 }]);
    if (q.includes('geo_suggestions')) return Promise.resolve([]);
    return Promise.resolve([]);
  };
  return { state, fakeSql };
});

vi.mock('../core/db.js', () => ({ getSql: () => h.fakeSql }));
vi.mock('../config.js', () => ({
  getConfigNumber: async (_k: string, fb: number) => fb,
  getConfigString: async (_k: string, fb: string) => fb,
  getConfigBool: async (_k: string, fb: boolean) => fb,
}));

import { gatherStats, renderStats, type Stats } from './stats.js';

beforeEach(() => {
  h.state.sourceRows = [];
  h.state.noAcqColumn = false;
  h.state.queries = [];
});

describe('gatherStats — acquisition labels', () => {
  it('reads label / total / week, biggest first', async () => {
    h.state.sourceRows = [
      { source: 'ads_ru1', total: 12, week: 9 },
      { source: 'ads_uz1', total: 5, week: 5 },
    ];
    const s = await gatherStats();

    expect(s.sourcesReady).toBe(true);
    expect(s.sources).toEqual([
      { source: 'ads_ru1', total: 12, week: 9 },
      { source: 'ads_uz1', total: 5, week: 5 },
    ]);
  });

  it('asks only for labelled rows, grouped, with a 7-day slice and a cap', async () => {
    await gatherStats();
    const q = h.state.queries.find((x) => x.includes('acq_source'))!;
    expect(q).toContain('where acq_source is not null');
    expect(q).toContain('group by acq_source');
    expect(q).toContain("interval '7 days'");
    expect(q).toContain('limit 20');
  });

  it('an empty result is READY-but-empty (nobody came yet), not "missing"', async () => {
    const s = await gatherStats();
    expect(s.sourcesReady).toBe(true);
    expect(s.sources).toEqual([]);
  });

  it('a missing column degrades to "no block" and leaves every other number intact', async () => {
    h.state.noAcqColumn = true;
    const s = await gatherStats();

    expect(s.sourcesReady).toBe(false);
    expect(s.sources).toEqual([]);
    expect(s.usersTotal).toBe(100);
    expect(s.vacancies).toBe(40);
    expect(s.aiCalls24h).toBe(10);
  });
});

/** A report with only the fields the acquisition block cares about; the rest are neutral zeros. */
function stats(over: Partial<Stats> = {}): Stats {
  return {
    usersTotal: 100, usersNew24h: 5, usersNew7d: 20, usersActive24h: 30, usersActive7d: 60,
    usersPmOk: 80, usersBlocked: 2, usersReferred: 7,
    vacancies: 40, adsApproved: 3, adsPending: 1, unverified: 9, unverifiedMaxAgeDays: 14,
    aiCalls24h: 0, aiInput24h: 0, aiOutput24h: 0, aiCacheRead24h: 0, aiColds24h: 0,
    aiCost24h: 0, aiCost30d: 0, aiProcessed24h: 0, aiReached24h: 0,
    unknownCities: [], slang: [],
    sourcesReady: true, sources: [],
    ...over,
  };
}

describe('renderStats — the owner reads this', () => {
  it('prints one line per campaign with the total and the week', () => {
    const text = renderStats(
      stats({ sources: [{ source: 'ads_ru1', total: 12, week: 9 }] }),
    );
    expect(text).toContain('Из рекламы (метка в ссылке):');
    expect(text).toContain('ads_ru1 — 12 человек (за неделю 9)');
  });

  it('sums several campaigns into a total line', () => {
    const text = renderStats(
      stats({
        sources: [
          { source: 'ads_ru1', total: 12, week: 9 },
          { source: 'ads_uz1', total: 5, week: 5 },
        ],
      }),
    );
    expect(text).toContain('ads_uz1 — 5 человек (за неделю 5)');
    expect(text).toContain('Всего по меткам: 17 человек (за неделю 14)');
  });

  it('says «пока никто» when the feature is live but nobody came', () => {
    expect(renderStats(stats())).toContain('Из рекламы: пока никто не пришёл по ссылке с меткой');
  });

  it('omits the block entirely while the column is not there yet', () => {
    const text = renderStats(stats({ sourcesReady: false }));
    expect(text).not.toContain('Из рекламы');
    // …and the rest of the report is untouched.
    expect(text).toContain('Пользователи: всего 100');
  });

  it('counts people in Russian: 1 человек / 2 человека / 5 человек / 11 человек', () => {
    const t = (n: number) => renderStats(stats({ sources: [{ source: 'x', total: n, week: 0 }] }));
    expect(t(1)).toContain('x — 1 человек ');
    expect(t(2)).toContain('x — 2 человека ');
    expect(t(5)).toContain('x — 5 человек ');
    expect(t(11)).toContain('x — 11 человек ');
    expect(t(21)).toContain('x — 21 человек ');
    expect(t(22)).toContain('x — 22 человека ');
  });

  it('keeps the report plain text and every old line in place', () => {
    const text = renderStats(stats({ sources: [{ source: 'ads_ru1', total: 12, week: 9 }] }));
    expect(text).toContain('Статистика');
    expect(text).toContain('пришли по рефералке: 7');
    expect(text).toContain('Вакансии в ленте: 40');
    expect(text.length).toBeLessThan(4096); // Bot API sendMessage limit
  });
});
