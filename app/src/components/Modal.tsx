import type { ReactNode } from 'react';

interface ModalProps {
  open: boolean;
  title: string;
  children: ReactNode;
  actions: ReactNode;
}

/**
 * Centered, non-dismissable modal (no backdrop close) used for the one-time
 * terms consent. Dismissal is only via an explicit action button.
 */
export function Modal({ open, title, children, actions }: ModalProps) {
  if (!open) return null;
  return (
    <div className="modal" role="dialog" aria-modal="true">
      <div className="modal__backdrop" />
      <div className="modal__card">
        <div className="modal__title">{title}</div>
        <div className="modal__body">{children}</div>
        <div className="modal__actions">{actions}</div>
      </div>
    </div>
  );
}
