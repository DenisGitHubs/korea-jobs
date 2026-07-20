import { useTranslation } from 'react-i18next';
import type { WorkType } from '../shared/types/api';
import { workTypeKey } from '../shared/labels';
import { WorkTypeIcon } from './icons/WorkTypeIcon';

export function WorkTypeBadge({ type }: { type: WorkType }) {
  const { t } = useTranslation();
  return (
    <span className="badge badge--work">
      <WorkTypeIcon type={type} />
      {t(workTypeKey(type))}
    </span>
  );
}
