import type { AnimationEvent, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '../lib/motion';

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Right-aligned control in the header (e.g. a Reset button). */
  headerAction?: ReactNode;
}

/**
 * Bottom sheet overlay used for the feed filter. Opens with a slide-up + backdrop
 * fade and closes symmetrically (slide-down + fade-out) before unmounting; a
 * reduced-motion preference collapses both to an instant open/close.
 */
export function Sheet({ open, onClose, title, children, footer, headerAction }: SheetProps) {
  const [render, setRender] = useState(open);
  const [closing, setClosing] = useState(false);
  // Keep the last content around while animating closed, so the panel never
  // flashes empty if the parent clears its props on close.
  const last = useRef<Pick<SheetProps, 'title' | 'children' | 'footer' | 'headerAction'>>({
    title,
    children,
    footer,
    headerAction,
  });
  if (open) last.current = { title, children, footer, headerAction };

  // Esc closes — only while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Mount on open.
  useEffect(() => {
    if (open) {
      setRender(true);
      setClosing(false);
    }
  }, [open]);

  // Animate out, then unmount. The timer is a fallback in case animationend is
  // missed; reduced motion skips the animation and unmounts immediately.
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
    }, 260);
    return () => window.clearTimeout(t);
  }, [open, render]);

  if (!render) return null;

  const view = open ? { title, children, footer, headerAction } : last.current;

  // Only the panel's OWN close animation unmounts (ignore bubbled child anims).
  const onExitEnd = (e: AnimationEvent): void => {
    if (e.target === e.currentTarget && !open) {
      setClosing(false);
      setRender(false);
    }
  };

  return (
    <div className={`sheet ${closing ? 'sheet--closing' : ''}`} role="dialog" aria-modal="true">
      <div className="sheet__backdrop" onClick={onClose} />
      <div className="sheet__panel" onAnimationEnd={onExitEnd}>
        <div className="sheet__head">
          <button className="sheet__close" onClick={onClose} aria-label="close">
            ✕
          </button>
          <div className="sheet__title">{view.title}</div>
          <div className="sheet__head-action">{view.headerAction}</div>
        </div>
        <div className="sheet__body">{view.children}</div>
        {view.footer ? <div className="sheet__footer">{view.footer}</div> : null}
      </div>
    </div>
  );
}
