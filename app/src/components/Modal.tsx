import type { AnimationEvent, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '../lib/motion';

interface ModalProps {
  open: boolean;
  title: string;
  children: ReactNode;
  actions: ReactNode;
}

/**
 * Centered, non-dismissable modal (no backdrop close). Opens with a fade + scale
 * and closes symmetrically before unmounting; reduced motion collapses both to an
 * instant open/close. Dismissal is only via an explicit action button.
 */
export function Modal({ open, title, children, actions }: ModalProps) {
  const [render, setRender] = useState(open);
  const [closing, setClosing] = useState(false);
  // Retain last content during the close animation (parent often clears it).
  const last = useRef<Pick<ModalProps, 'title' | 'children' | 'actions'>>({ title, children, actions });
  if (open) last.current = { title, children, actions };

  useEffect(() => {
    if (open) {
      setRender(true);
      setClosing(false);
    }
  }, [open]);

  useEffect(() => {
    if (open || !render) return;
    if (prefersReducedMotion()) {
      setRender(false);
      return;
    }
    setClosing(true);
    const t = window.setTimeout(() => {
      setClosing(false);
      setRender(false);
    }, 240);
    return () => window.clearTimeout(t);
  }, [open, render]);

  if (!render) return null;

  const view = open ? { title, children, actions } : last.current;

  const onExitEnd = (e: AnimationEvent): void => {
    if (e.target === e.currentTarget && !open) {
      setClosing(false);
      setRender(false);
    }
  };

  return (
    <div className={`modal ${closing ? 'modal--closing' : ''}`} role="dialog" aria-modal="true">
      <div className="modal__backdrop" />
      <div className="modal__card" onAnimationEnd={onExitEnd}>
        <div className="modal__title">{view.title}</div>
        <div className="modal__body">{view.children}</div>
        <div className="modal__actions">{view.actions}</div>
      </div>
    </div>
  );
}
