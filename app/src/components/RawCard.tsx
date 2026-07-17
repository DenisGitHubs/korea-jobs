import { useTranslation } from 'react-i18next';
import type { RawView } from '../shared/types/api';

/**
 * A listing the AI could not structure. Amber "unverified" signal, italic
 * scrubbed text, coarse age. No city/salary/contact — read-only, not tappable.
 */
export function RawCard({ raw }: { raw: RawView }) {
  const { t } = useTranslation();
  const age = raw.age_hint <= 0 ? t('time.justNow') : t('time.days', { count: raw.age_hint });
  return (
    <div className="card card--raw">
      <div className="card__badges">
        <span className="badge badge--raw">⚠ {t('raw.badge')}</span>
        <span className="card__time">{age}</span>
      </div>
      <div className="card__desc card__desc--raw">{raw.text}</div>
    </div>
  );
}
