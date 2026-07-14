import type { ReactNode } from 'react';
import { useEffect } from 'react';

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Right-aligned control in the header (e.g. a Reset button). */
  headerAction?: ReactNode;
}

/** Bottom sheet overlay used for the feed filter. */
export function Sheet({ open, onClose, title, children, footer, headerAction }: SheetProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="sheet" role="dialog" aria-modal="true">
      <div className="sheet__backdrop" onClick={onClose} />
      <div className="sheet__panel">
        <div className="sheet__head">
          <button className="sheet__close" onClick={onClose} aria-label="close">
            ✕
          </button>
          <div className="sheet__title">{title}</div>
          <div className="sheet__head-action">{headerAction}</div>
        </div>
        <div className="sheet__body">{children}</div>
        {footer ? <div className="sheet__footer">{footer}</div> : null}
      </div>
    </div>
  );
}
