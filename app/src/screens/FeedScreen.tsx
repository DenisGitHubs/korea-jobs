import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../shared/api/client';
import type { VacancyView } from '../shared/types/api';
import { subscriptionValue, useSubscriptionStore } from '../store/subscriptionStore';
import { filterSignature, filterToQuery, isFilterActive, useFilterStore } from '../store/filterStore';
import { useFeedStore } from '../store/feedStore';
import { AppBar } from '../components/AppBar';
import { Loading } from '../components/Loading';
import { EmptyState } from '../components/EmptyState';
import { VacancyCard } from '../components/VacancyCard';
import { FilterSheet } from '../components/FilterSheet';

function FilterIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 5h18l-7 8.2V19l-4 2v-7.8z" />
    </svg>
  );
}

export default function FeedScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const filter = useFilterStore((s) => s.value);
  const sig = filterSignature(filter);
  const active = isFilterActive(filter);

  const [items, setItems] = useState<VacancyView[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const busy = useRef(false);

  // Seed the temporary filter default from the persistent subscription (once).
  useEffect(() => {
    useFilterStore.getState().initFromSubscription(subscriptionValue(useSubscriptionStore.getState()));
  }, []);

  // Load (or restore from cache) whenever the applied filter signature changes.
  useEffect(() => {
    let alive = true;
    const cached = useFeedStore.getState().get(sig);
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
    api
      .vacancies(filterToQuery(filter))
      .then((page) => {
        if (!alive) return;
        setItems(page.items);
        setCursor(page.next_cursor ?? undefined);
        setHasMore(page.next_cursor != null);
        useFeedStore.getState().set(sig, {
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
  }, [sig]);

  // Persist scroll position when leaving the feed.
  useEffect(() => {
    return () => {
      useFeedStore.getState().patch(sig, { scrollY: window.scrollY });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  const loadMore = useCallback(() => {
    if (busy.current || !hasMore || loading || !cursor) return;
    busy.current = true;
    setLoadingMore(true);
    api
      .vacancies({ ...filterToQuery(filter), cursor })
      .then((page) => {
        setItems((prev) => {
          const next = [...prev, ...page.items];
          useFeedStore.getState().set(sig, {
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
        setLoadingMore(false);
        busy.current = false;
      });
  }, [cursor, hasMore, loading, filter, sig]);

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

  const right = (
    <button
      className={`appbar__btn appbar__btn--icon ${active ? 'appbar__btn--dot' : ''}`}
      onClick={() => setFilterOpen(true)}
      aria-label={t('feed.filter')}
    >
      <FilterIcon />
    </button>
  );

  return (
    <div className="app">
      <AppBar title={t('feed.title')} right={right} />
      <div className="screen">
        {loading ? (
          <Loading text={t('common.loading')} />
        ) : error && !items.length ? (
          <EmptyState
            emoji="⚠️"
            title={t('common.error')}
            actionLabel={t('common.retry')}
            onAction={() => navigate(0)}
          />
        ) : !items.length ? (
          <EmptyState
            emoji="🗂️"
            title={t('feed.emptyTitle')}
            subtitle={t('feed.emptyRelax')}
            actionLabel={t('feed.emptyCta')}
            onAction={() => setFilterOpen(true)}
          />
        ) : (
          <>
            {items.map((v) => (
              <VacancyCard key={v.id} vacancy={v} onOpen={openVacancy} />
            ))}
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
