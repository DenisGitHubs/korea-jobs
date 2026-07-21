import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { api, ApiError } from '../shared/api/client';
import type { RawView, Stats, VacancyView } from '../shared/types/api';
import { feeKey, freshnessKey, visaKey, workTypeKey } from '../shared/labels';
import { subscriptionValue, useSubscriptionStore } from '../store/subscriptionStore';
import { filterSignature, filterToQuery, isFilterActive, useFilterStore, type FilterValue } from '../store/filterStore';
import { applySaveToCaches, revertSaveInCaches, useFeedStore, type FeedItem } from '../store/feedStore';
import { useUiStore, type FeedSegment } from '../store/uiStore';
import { useCountUp } from '../hooks/useCountUp';
import { AppBar } from '../components/AppBar';
import { Loading } from '../components/Loading';
import { EmptyState } from '../components/EmptyState';
import { Segmented } from '../components/Segmented';
import { VacancyCard, HeartIcon } from '../components/VacancyCard';
import { RawCard } from '../components/RawCard';
import { FilterSheet } from '../components/FilterSheet';
import { ReferralBanner } from '../components/ReferralBanner';
import { IconCheckCircle, IconSearch, IconWarn } from '../components/icons/StateIcons';

type Segment = FeedSegment;

function FilterIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 5h18l-7 8.2V19l-4 2v-7.8z" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.2-3.2" />
    </svg>
  );
}

function WarnIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

/**
 * Inline feed search. Writes into the shared filter's `keywords` (→ `?q=`) with a
 * debounce, and mirrors external changes (filter sheet / quickfilter clear).
 */
function FeedSearch() {
  const { t } = useTranslation();
  const keywords = useFilterStore((s) => s.value.keywords);
  const apply = useFilterStore((s) => s.apply);
  const [q, setQ] = useState(keywords);

  useEffect(() => {
    setQ(keywords);
  }, [keywords]);

  useEffect(() => {
    if (q === keywords) return;
    const id = window.setTimeout(() => {
      apply({ ...useFilterStore.getState().value, keywords: q });
    }, 350);
    return () => window.clearTimeout(id);
  }, [q, keywords, apply]);

  return (
    <div className={`searchbar ${q ? 'searchbar--filled' : ''}`}>
      <SearchIcon />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('feed.searchPlaceholder')}
        aria-label={t('feed.searchPlaceholder')}
        enterKeyHint="search"
      />
      <button className="searchbar__clear" onClick={() => setQ('')} aria-label={t('feed.searchClear')}>
        ✕
      </button>
    </div>
  );
}

/** Product-value strip: total offers × source chats (numbers count up on load). */
function FeedAggBar() {
  const { t } = useTranslation();
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .stats()
      .then((s) => {
        if (alive) setStats(s);
      })
      .catch(() => {
        /* stats are non-critical — just hide the bar on failure */
      });
    return () => {
      alive = false;
    };
  }, []);

  const [vac, vacPop] = useCountUp(stats?.vacancies_count ?? 0);

  // Owner rule (2026-07-19): show only the vacancy count — the "из N чатов" source
  // count is intentionally NOT displayed (sources_count stays in the API response).
  if (!stats) return null;
  return (
    <div className="aggbar" role="status">
      <span className="aggbar__dot" aria-hidden />
      <span>
        <b className={vacPop}>{vac}</b> {t('feed.aggVacancies', { count: stats.vacancies_count })}
      </span>
    </div>
  );
}

/** Amber notice atop the "Не разобрано" segment. */
function RawNote() {
  const { t } = useTranslation();
  return (
    <div className="rawnote">
      <span className="rawnote__ico">
        <WarnIcon />
      </span>
      <div>
        <div className="rawnote__t">{t('raw.noteTitle')}</div>
        <div className="rawnote__s">{t('raw.note')}</div>
      </div>
    </div>
  );
}

export default function FeedScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const filter = useFilterStore((s) => s.value);
  const applyFilter = useFilterStore((s) => s.apply);
  const sig = filterSignature(filter);
  const active = isFilterActive(filter);

  // Remember the last-viewed tab across navigations (session store): returning
  // from a card restores the segment; the per-segment feed cache restores scroll.
  const segment = useUiStore((s) => s.feedSegment);
  const setSegment = useUiStore((s) => s.setFeedSegment);
  const [items, setItems] = useState<FeedItem[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // Which cacheKey currently owns the load-more lock (null = free). Keyed rather than
  // a plain boolean so a stale in-flight request can never release a newer view's lock.
  const busyKey = useRef<string | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const cacheKey = segment === 'all' ? `all:${sig}` : segment;
  // Always-current cacheKey, so an in-flight page request can detect that the user
  // switched segment/filter meanwhile and discard its now-stale result.
  const cacheKeyRef = useRef(cacheKey);
  cacheKeyRef.current = cacheKey;

  // Seed the temporary filter default from the persistent subscription (once).
  useEffect(() => {
    useFilterStore.getState().initFromSubscription(subscriptionValue(useSubscriptionStore.getState()));
  }, []);

  const fetchPage = useCallback(
    (cur?: string) => {
      if (segment === 'saved') return api.saved(cur ? { cursor: cur } : {});
      if (segment === 'raw') return api.raw(cur ? { cursor: cur } : {});
      return api.vacancies({ ...filterToQuery(filter), cursor: cur });
    },
    [segment, filter],
  );

  // Load (or restore from cache) whenever the segment or the (All) filter changes.
  useEffect(() => {
    let alive = true;
    // New segment/filter: release any load-more lock still held by the previous view
    // (its in-flight request, if any, self-discards) so this view's pagination is not
    // blocked, and hide a leftover spinner.
    busyKey.current = null;
    setLoadingMore(false);
    // `retry` drops this cache first, so a present cache here is always safe to restore.
    const cached = useFeedStore.getState().get(cacheKey);
    if (cached) {
      setItems(cached.items);
      setCursor(cached.cursor ?? undefined);
      setHasMore(cached.hasMore);
      setLoading(false);
      setError(null);
      requestAnimationFrame(() => window.scrollTo(0, cached.scrollY));
      return;
    }

    setItems([]);
    setCursor(undefined);
    setHasMore(true);
    setError(null);
    setLoading(true);
    fetchPage()
      .then((page) => {
        if (!alive) return;
        setItems(page.items);
        setCursor(page.next_cursor ?? undefined);
        setHasMore(page.next_cursor != null);
        useFeedStore.getState().set(cacheKey, {
          items: page.items,
          cursor: page.next_cursor,
          hasMore: page.next_cursor != null,
          scrollY: 0,
        });
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof ApiError ? e.code : 'error');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, reloadKey]);

  // Persist scroll position when leaving the current segment/view.
  useEffect(() => {
    return () => {
      useFeedStore.getState().patch(cacheKey, { scrollY: window.scrollY });
    };
  }, [cacheKey]);

  const loadMore = useCallback(() => {
    if (busyKey.current !== null || !hasMore || loading || !cursor) return;
    // Bind this request to the segment/filter it was started for.
    const key = cacheKey;
    busyKey.current = key;
    setLoadingMore(true);
    fetchPage(cursor)
      .then((page) => {
        // Stale-guard: the user switched segment/filter while this was in flight.
        // Discard the result so we never append RawView to VacancyView (or vice
        // versa) or overwrite another segment's cache under a mismatched key.
        if (cacheKeyRef.current !== key) return;
        setItems((prev) => {
          const next = [...prev, ...page.items];
          useFeedStore.getState().set(key, {
            items: next,
            cursor: page.next_cursor,
            hasMore: page.next_cursor != null,
            scrollY: window.scrollY,
          });
          return next;
        });
        setCursor(page.next_cursor ?? undefined);
        setHasMore(page.next_cursor != null);
      })
      .catch(() => {
        /* keep what we have; user can scroll again */
      })
      .finally(() => {
        // Only release the lock / hide the spinner if it still belongs to this key;
        // otherwise a newer segment already owns them and must not be disturbed.
        if (busyKey.current === key) {
          busyKey.current = null;
          setLoadingMore(false);
        }
      });
  }, [cursor, hasMore, loading, fetchPage, cacheKey]);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { rootMargin: '240px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);

  const openVacancy = useCallback((id: string) => navigate(`/feed/${id}`), [navigate]);

  // Optimistic bookmark toggle. Keeps every cached segment coherent; on the Saved
  // segment, removing a bookmark drops the card. Reverts on network error.
  const toggleSave = useCallback(
    (v: VacancyView) => {
      const next = !v.is_saved;
      const snapshot = itemsRef.current;
      const updated =
        segment === 'saved' && !next
          ? snapshot.filter((x) => x.id !== v.id)
          : snapshot.map((x) => (x.id === v.id && x.source_kind !== 'raw' ? { ...x, is_saved: next } : x));
      setItems(updated);
      applySaveToCaches(v.id, next);
      (next ? api.saveVacancy(v.id) : api.unsaveVacancy(v.id)).catch(() => {
        setItems(snapshot);
        revertSaveInCaches(v.id, v.is_saved);
      });
    },
    [segment],
  );

  const retry = useCallback(() => {
    useFeedStore.getState().drop(cacheKey);
    setReloadKey((k) => k + 1);
  }, [cacheKey]);

  const right = (
    <button
      className={`appbar__btn appbar__btn--icon ${active ? 'appbar__btn--dot' : ''}`}
      onClick={() => setFilterOpen(true)}
      aria-label={t('feed.filter')}
    >
      <FilterIcon />
    </button>
  );

  const segOptions = [
    { value: 'all' as const, label: t('feed.segAll') },
    { value: 'saved' as const, label: `♥ ${t('feed.segSaved')}` },
    { value: 'raw' as const, label: `⚠ ${t('feed.segRaw')}` },
  ];

  return (
    <div className="app">
      <AppBar title={t('feed.title')} right={right} />
      {segment === 'all' && active ? <QuickFilters filter={filter} apply={applyFilter} t={t} /> : null}
      <div className="screen">
        <Segmented<Segment>
          className="segmented--block"
          value={segment}
          options={segOptions}
          onChange={setSegment}
        />

        {segment === 'all' ? (
          <>
            <FeedSearch />
            <ReferralBanner />
            <FeedAggBar />
          </>
        ) : null}

        {loading ? (
          <FeedSkeleton />
        ) : error && !items.length ? (
          <EmptyState icon={<IconWarn />} title={t('common.error')} actionLabel={t('common.retry')} onAction={retry} />
        ) : !items.length ? (
          segment === 'saved' ? (
            <div className="feed-empty">
              <div className="feed-empty__art">
                <HeartIcon />
              </div>
              <div className="feed-empty__title">{t('feed.savedEmptyTitle')}</div>
              <div className="feed-empty__sub">{t('feed.savedEmptySub')}</div>
            </div>
          ) : segment === 'raw' ? (
            <EmptyState icon={<IconCheckCircle />} title={t('feed.rawEmptyTitle')} subtitle={t('feed.rawEmptySub')} />
          ) : (
            <EmptyState
              icon={<IconSearch />}
              title={t('feed.emptyTitle')}
              subtitle={t('feed.emptyRelax')}
              actionLabel={t('feed.emptyCta')}
              onAction={() => setFilterOpen(true)}
            />
          )
        ) : (
          <>
            {segment === 'raw' ? <RawNote /> : null}
            <div className="feed-list">
              {segment === 'raw'
                ? (items as RawView[]).map((r) => <RawCard key={r.id} raw={r} />)
                : (items as VacancyView[]).map((v) => (
                    <VacancyCard key={v.id} vacancy={v} onOpen={openVacancy} onToggleSave={toggleSave} />
                  ))}
            </div>
            <div ref={sentinelRef} />
            {loadingMore ? (
              <Loading text={t('feed.loadingMore')} />
            ) : !hasMore ? (
              <div className="center muted">{t('feed.end')}</div>
            ) : null}
          </>
        )}
      </div>

      <FilterSheet open={filterOpen} onClose={() => setFilterOpen(false)} />
    </div>
  );
}

/** Active-filter chips under the AppBar; each ✕ drops one condition (re-fetches). */
function QuickFilters({
  filter,
  apply,
  t,
}: {
  filter: FilterValue;
  apply: (v: FilterValue) => void;
  t: TFunction;
}) {
  // Keyword is shown/edited by the inline search bar, so it's not repeated here.
  const chips: Array<{ key: string; label: string; onRemove: () => void }> = [];
  if (filter.freshness != null)
    chips.push({
      key: 'fresh',
      label: t(freshnessKey(filter.freshness)),
      onRemove: () => apply({ ...filter, freshness: null }),
    });
  for (const w of filter.workTypes)
    chips.push({
      key: `w-${w}`,
      label: t(workTypeKey(w)),
      onRemove: () => apply({ ...filter, workTypes: filter.workTypes.filter((x) => x !== w) }),
    });
  for (const v of filter.visa)
    chips.push({
      key: `visa-${v}`,
      label: t(visaKey(v)),
      onRemove: () => apply({ ...filter, visa: filter.visa.filter((x) => x !== v) }),
    });
  if (filter.paid)
    chips.push({ key: 'paid', label: t(feeKey(filter.paid)), onRemove: () => apply({ ...filter, paid: null }) });
  if (filter.housing)
    chips.push({ key: 'housing', label: t('filter.housing'), onRemove: () => apply({ ...filter, housing: false }) });
  if (filter.meals)
    chips.push({ key: 'meals', label: t('filter.meals'), onRemove: () => apply({ ...filter, meals: false }) });
  if (filter.cities.length)
    chips.push({
      key: 'cities',
      label: `${t('filter.citiesSection')} · ${filter.cities.length}${
        filter.noCity ? ` + ${t('filter.unspecifiedShort')}` : ''
      }`,
      onRemove: () => apply({ ...filter, cities: [], noCity: true }),
    });

  if (!chips.length) return null;
  return (
    <div className="quickfilters">
      {chips.map((c) => (
        <button key={c.key} type="button" className="qf-chip" onClick={c.onRemove}>
          {c.label}
          <span className="qf-chip__x" aria-hidden>
            ✕
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * Shimmer placeholders shaped like a real VacancyCard: a city-line + heart row,
 * a row of pill badges, two text lines and an employer line. Keeps the loading
 * state from "jumping" when the real cards paint in.
 */
function FeedSkeleton() {
  return (
    <div aria-hidden>
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="skeleton-card">
          <div className="skeleton-cardtop">
            <span className="skeleton-line skeleton-line--sm" />
            <span className="skeleton-dot" />
          </div>
          <div className="skeleton-pills">
            <span className="skeleton-pill" />
            <span className="skeleton-pill skeleton-pill--wide" />
            <span className="skeleton-pill" />
          </div>
          <span className="skeleton-line" />
          <span className="skeleton-line skeleton-line--w80" />
          <span className="skeleton-line skeleton-line--sm skeleton-line--gap" />
        </div>
      ))}
    </div>
  );
}
