import { useTranslation } from 'react-i18next';
import type { VacancyView } from '../shared/types/api';
import { useSettingsStore } from '../store/settingsStore';
import { localized } from '../lib/localized';
import { salaryLine, timeAgo } from '../lib/format';
import { genderKey } from '../shared/labels';
import { WorkTypeBadge } from './WorkTypeBadge';

export function VacancyCard({ vacancy, onOpen }: { vacancy: VacancyView; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const lang = useSettingsStore((s) => s.lang);
  const cityName = vacancy.city ? localized(vacancy.city.name, lang) : t('region.other');
  const salary = salaryLine(vacancy, t);

  return (
    <button className="card" onClick={() => onOpen(vacancy.id)}>
      <div className="card__top">
        <span className="card__city">{cityName}</span>
        <span className="card__time">{timeAgo(vacancy.posted_at, t)}</span>
      </div>
      <div className="card__badges">
        <WorkTypeBadge type={vacancy.work_type} />
        {vacancy.gender !== 'any' ? (
          <span className="badge badge--gender">{t(genderKey(vacancy.gender))}</span>
        ) : null}
      </div>
      {salary ? <div className="card__salary">{salary}</div> : null}
      <div className="card__desc">{vacancy.description}</div>
      {vacancy.employer ? <div className="card__employer">{vacancy.employer}</div> : null}
    </button>
  );
}
