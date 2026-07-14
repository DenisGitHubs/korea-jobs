import { useTranslation } from 'react-i18next';
import type { WorkType } from '../shared/types/api';
import { WORK_TYPE_EMOJI, workTypeKey } from '../shared/labels';

export function WorkTypeBadge({ type }: { type: WorkType }) {
  const { t } = useTranslation();
  return (
    <span className="badge badge--work">
      <span aria-hidden>{WORK_TYPE_EMOJI[type]}</span>
      {t(workTypeKey(type))}
    </span>
  );
}
