import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../shared/api/client';
import type { VacancyView } from '../shared/types/api';
import { useSubscriptionStore } from '../store/subscriptionStore';
import { AppBar } from '../components/AppBar';
import { Loading } from '../components/Loading';
import { EmptyState } from '../components/EmptyState';
import { VacancyCard } from '../components/VacancyCard';

export default function FeedScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const citySlugs = useSubscriptionStore((s) => s.citySlugs);
  const workTypes = useSubscriptionStore((s) => s.workTypes);
  const cityKey = citySlugs.join(',');
  const workKey = workTypes.join(',');

  const [items, setItems] = useState<VacancyView[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  // (Re)load the first page whenever the selected cities / work types change.
  useEffect(() => {
    let alive = true;
    setItems([]);
    setCursor(undefined);
    setHasMore(true);
    setError(null);

    if (!citySlugs.length) {
      setLoading(false);
      setHasMore(false);
      return;
    }

    setLoading(true);
    api
      .vacancies({ cities: citySlugs, work_types: workTypes })
      .then((page) => {
        if (!alive) return;
        setItems(page.items);
        setCursor(page.next_cursor ?? undefined);
        setHasMore(page.next_cursor != null);
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
  }, [cityKey, workKey]);

  const loadMore = useCallback(() => {
    if (busy.current || !hasMore || loading || !cursor) return;
    busy.current = true;
    setLoadingMore(true);
    api
      .vacancies({ cities: citySlugs, work_types: workTypes, cursor })
      .then((page) => {
        setItems((prev) => [...prev, ...page.items]);
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
  }, [cursor, hasMore, loading, citySlugs, workTypes]);

  // Infinite scroll via a sentinel near the end of the list.
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

  const openVacancy = useCallback((id: string) => navigate(`/vacancy/${id}`), [navigate]);

  const left = (
    <button className="appbar__btn" onClick={() => navigate('/filter')}>
      {t('nav.filter')}
    </button>
  );
  const right = (
    <button
      className="appbar__btn appbar__btn--icon"
      onClick={() => navigate('/settings')}
      aria-label={t('nav.settings')}
    >
      ⚙
    </button>
  );

  return (
    <div className="app">
      <AppBar title={t('feed.title')} left={left} right={right} />
      <div className="screen">
        {!citySlugs.length ? (
          <EmptyState
            emoji="📍"
            title={t('feed.emptyNoCitiesTitle')}
            subtitle={t('feed.emptyNoCitiesSubtitle')}
            actionLabel={t('feed.emptyCta')}
            onAction={() => navigate('/filter')}
          />
        ) : loading ? (
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
            subtitle={t('feed.emptySubtitle')}
            actionLabel={t('feed.emptyCta')}
            onAction={() => navigate('/filter')}
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
    </div>
  );
}
