import type { TFunction } from 'i18next';
import type { SalaryPeriod, VacancyView } from '../shared/types/api';

/** Human "time ago" using the i18n time.* keys. */
export function timeAgo(iso: string, t: TFunction): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return t('time.justNow');
  if (min < 60) return t('time.minutes', { count: min });
  const hours = Math.floor(min / 60);
  if (hours < 24) return t('time.hours', { count: hours });
  const days = Math.floor(hours / 24);
  return t('time.days', { count: days });
}

const KRW = new Intl.NumberFormat('ko-KR');

/**
 * Best salary string for a card:
 * prefer the raw `salary_text` as written; otherwise synthesize from min/max +
 * period; otherwise null (caller shows "not specified").
 */
export function salaryLine(v: VacancyView, t: TFunction): string | null {
  if (v.salary_text && v.salary_text.trim()) return v.salary_text.trim();

  const parts: string[] = [];
  if (v.salary_min != null && v.salary_max != null && v.salary_min !== v.salary_max) {
    parts.push(`${KRW.format(v.salary_min)}–${KRW.format(v.salary_max)}₩`);
  } else if (v.salary_min != null) {
    parts.push(`${KRW.format(v.salary_min)}₩`);
  } else if (v.salary_max != null) {
    parts.push(`${KRW.format(v.salary_max)}₩`);
  }
  if (!parts.length) return null;
  if (v.salary_period) parts.push(t(periodKeySafe(v.salary_period)));
  return parts.join(' ');
}

function periodKeySafe(p: SalaryPeriod): string {
  return `period.${p}`;
}
