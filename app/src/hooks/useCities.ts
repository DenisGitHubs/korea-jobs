import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../shared/api/client';
import type { City } from '../shared/types/api';
import { groupByRegion } from '../shared/regions';

export interface UseCitiesResult {
  cities: City[] | null;
  grouped: Array<{ region: string; items: City[] }>;
  bySlug: Map<string, City>;
  loading: boolean;
  error: string | null;
}

/** Load the city list once and expose it grouped by region + a slug lookup. */
export function useCities(): UseCitiesResult {
  const [cities, setCities] = useState<City[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .cities()
      .then((c) => {
        if (alive) setCities(c);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof ApiError ? e.code : 'error');
      });
    return () => {
      alive = false;
    };
  }, []);

  const grouped = useMemo(() => (cities ? groupByRegion(cities) : []), [cities]);
  const bySlug = useMemo(() => new Map((cities ?? []).map((c) => [c.slug, c])), [cities]);

  return { cities, grouped, bySlug, loading: cities === null && error === null, error };
}
