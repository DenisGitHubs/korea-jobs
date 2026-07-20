import type { ReactNode } from 'react';

interface EmptyStateProps {
  /** Line icon rendered in a soft brand-tint disc above the title. */
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function EmptyState({ icon, title, subtitle, actionLabel, onAction }: EmptyStateProps) {
  return (
    <div className="empty">
      {icon ? (
        <div className="empty__icon" aria-hidden>
          {icon}
        </div>
      ) : null}
      <div className="empty__title">{title}</div>
      {subtitle ? <div className="empty__sub">{subtitle}</div> : null}
      {actionLabel && onAction ? (
        <button className="btn btn--primary" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}
