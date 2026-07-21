import type { KeyboardEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { VacancyView } from '../shared/types/api';
import { useSettingsStore } from '../store/settingsStore';
import { useFilterStore } from '../store/filterStore';
import { cityLabel } from '../lib/cities';
import { timeAgo } from '../lib/format';
import { genderKey } from '../shared/labels';
import { WorkTypeBadge } from './WorkTypeBadge';
import { IconCheck } from './icons/StateIcons';

/** Max badges shown on a card; the rest collapse into a "+N" chip. */
const MAX_BADGES = 4;

/** Bookmark heart. Fill/stroke follow `filled`; colour comes from CSS. */
export function HeartIcon({ filled }: { filled?: boolean }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z" />
    </svg>
  );
}

export function VacancyCard({
  vacancy,
  onOpen,
  onToggleSave,
}: {
  vacancy: VacancyView;
  onOpen: (id: string) => void;
  /** When provided, a bookmark heart is shown (feed / saved segments). */
  onToggleSave?: (v: VacancyView) => void;
}) {
  const { t } = useTranslation();
  const lang = useSettingsStore((s) => s.lang);
  const filterCities = useFilterStore((s) => s.value.cities);

  // Multi-city display: prefer the city that matches the user's active city
  // filter (if any), otherwise the main city (first). A "+N" badge counts the
  // rest; the full list goes into aria-label. 0 cities → "city not specified".
  const cities = vacancy.cities?.length ? vacancy.cities : vacancy.city ? [vacancy.city] : [];
  const shown =
    (cities.length > 1 && filterCities.length
      ? cities.find((c) => filterCities.includes(c.slug))
      : undefined) ?? cities[0];
  const cityName = shown ? cityLabel(shown, lang, t) : t('city.unspecified');
  const cityExtra = cities.length > 1 ? cities.length - 1 : 0;
  const cityAria = cities.length ? cities.map((c) => cityLabel(c, lang, t)).join(', ') : t('city.unspecified');

  const isRepost = Boolean((vacancy as { repost?: boolean }).repost);
  const fromUser = vacancy.source_kind === 'user';

  // Priority order: work-type + perks (housing/meals) rank above gender/source/repost.
  const badges: ReactNode[] = [<WorkTypeBadge key="work" type={vacancy.work_type} />];
  if (vacancy.has_housing === true)
    badges.push(
      <span key="housing" className="badge badge--perk">
        {t('vacancy.housing')}
      </span>,
    );
  if (vacancy.has_meals === true)
    badges.push(
      <span key="meals" className="badge badge--perk">
        {t('vacancy.meals')}
      </span>,
    );
  if (vacancy.gender !== 'any')
    badges.push(
      <span key="gender" className="badge badge--gender">
        {t(genderKey(vacancy.gender))}
      </span>,
    );
  if (fromUser)
    badges.push(
      <span key="source" className="badge badge--source">
        {t('vacancy.fromUser')}
      </span>,
    );
  if (isRepost)
    badges.push(
      <span key="repost" className="badge badge--repost">
        {t('vacancy.repost')}
      </span>,
    );

  const visible = badges.slice(0, MAX_BADGES);
  const overflow = badges.length - visible.length;

  const open = (): void => onOpen(vacancy.id);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    // Only when the card itself is focused — not the nested bookmark button.
    if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      open();
    }
  };

  // Root is a role=button div (not <button>) so the bookmark <button> can nest validly.
  return (
    <div className="card" role="button" tabIndex={0} onClick={open} onKeyDown={onKeyDown}>
      <div className="card__top">
        <div className="card__cityline">
          <span className="card__city" aria-label={cityAria}>
            {cityName}
          </span>
          {cityExtra > 0 ? (
            <span className="badge badge--count" aria-hidden>
              +{cityExtra}
            </span>
          ) : null}
          <span className="card__time">{timeAgo(vacancy.posted_at, t)}</span>
          {/* Quiet "you already opened this contact" marker (repeat reveal is free). */}
          {vacancy.is_revealed ? (
            <span className="card__revealed">
              <IconCheck />
              {t('vacancy.revealed')}
            </span>
          ) : null}
        </div>
        {onToggleSave ? (
          <button
            type="button"
            className={`card__save ${vacancy.is_saved ? 'card__save--on' : ''}`}
            aria-pressed={vacancy.is_saved}
            aria-label={t(vacancy.is_saved ? 'feed.unsave' : 'feed.save')}
            onClick={(e) => {
              e.stopPropagation();
              onToggleSave(vacancy);
            }}
          >
            <HeartIcon filled={vacancy.is_saved} />
          </button>
        ) : null}
      </div>
      <div className="card__badges">
        {visible}
        {overflow > 0 ? <span className="badge badge--count">+{overflow}</span> : null}
      </div>
      <div className="card__desc">{vacancy.description}</div>
      {vacancy.employer ? <div className="card__employer">{vacancy.employer}</div> : null}
    </div>
  );
}
