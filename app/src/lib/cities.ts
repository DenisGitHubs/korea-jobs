/**
 * City-label helpers shared by the picker, the vacancy card / screen, the feed
 * filter chip and the "Cities" summary rows. Keeps two concerns in one place:
 *   1. Homonym disambiguation — the two "Gwangju" (metropolis vs the Gyeonggi
 *      city) get a province suffix everywhere they appear OUTSIDE a province
 *      grouping (cards, vacancy screen, chips, the "selected" summary). Inside
 *      the picker's province groups the plain name is used (the group gives the
 *      context), so this map is applied only by `cityLabel`, never in-group.
 *   2. The single source of the "Cities" state summary string.
 */
import type { TFunction } from 'i18next';
import type { City, Localized } from '../shared/types/api';
import type { Lang } from '../i18n';
import { regionKey } from '../shared/labels';
import { localized } from './localized';

/** Quick-pick chips shown above the province list (owner's choice). */
export const FREQUENT_CITY_SLUGS = ['seoul', 'ansan', 'hwaseong', 'siheung', 'busan'] as const;

/** Slug -> i18n key for cities whose bare name is ambiguous out of context. */
const CITY_LABEL_OVERRIDE: Record<string, string> = {
  gwangju: 'city.gwangjuMetro',
  gwangju_gyeonggi: 'city.gwangjuGyeonggi',
};

type CityLite = { slug: string; name: Localized };

/**
 * Display label for a single city, with homonym disambiguation. Use everywhere a
 * city is shown WITHOUT its province context.
 */
export function cityLabel(city: CityLite, lang: Lang, t: TFunction): string {
  const key = CITY_LABEL_OVERRIDE[city.slug];
  return key ? t(key) : localized(city.name, lang);
}

/**
 * Human summary of the current city + region selection for the "Cities" nav rows
 * (filter sheet + settings). `noCity` = the "city not specified" toggle.
 *   [] cities + [] regions + noCity on  -> "All cities"
 *   [] cities + [] regions + noCity off -> "Without ‘not specified’"
 *   [one city]                          -> its (disambiguated) name
 *   [many cities]                       -> "N cities"
 *   [] cities + [one region]            -> "<Region> (whole region)"
 *   [] cities + [many regions]          -> "N regions"
 *   [cities] + [regions]                -> "<cityPart> + <regionPart>"
 *   any selection + noCity on           -> "<base> + not specified"
 */
export function citiesSummary(
  slugs: string[],
  regions: string[],
  noCity: boolean,
  bySlug: Map<string, City>,
  lang: Lang,
  t: TFunction,
): string {
  if (slugs.length === 0 && regions.length === 0) {
    return noCity ? t('filter.citiesAll') : t('filter.citiesNoneButNoCity');
  }

  const cityPart = (): string => {
    if (slugs.length === 1) {
      const c = bySlug.get(slugs[0]);
      return c ? cityLabel(c, lang, t) : t('filter.citiesCount', { count: 1 });
    }
    return t('filter.citiesCount', { count: slugs.length });
  };

  let base: string;
  if (slugs.length && regions.length) {
    base = t('filter.citiesPlusRegions', {
      cities: cityPart(),
      regions: t('filter.regionsCount', { count: regions.length }),
    });
  } else if (slugs.length) {
    base = cityPart();
  } else if (regions.length === 1) {
    base = t('filter.regionWhole', { region: t(regionKey(regions[0])) });
  } else {
    base = t('filter.regionsCount', { count: regions.length });
  }

  return noCity ? t('filter.citiesPlusUnspecified', { label: base }) : base;
}
