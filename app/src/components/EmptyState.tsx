interface EmptyStateProps {
  emoji?: string;
  title: string;
  subtitle?: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function EmptyState({ emoji = '🗂️', title, subtitle, actionLabel, onAction }: EmptyStateProps) {
  return (
    <div className="empty">
      <div className="empty__emoji" aria-hidden>
        {emoji}
      </div>
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
