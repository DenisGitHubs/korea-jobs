import type { ReactNode } from 'react';
import type { WorkType } from '../../shared/types/api';

/**
 * Contour glyph per work type (product UI, not chrome). Replaces the old emoji
 * set: strokes follow `currentColor`, so a glyph inherits its chip/badge text
 * colour (incl. the selected-chip ink) and both themes automatically. Sized in
 * `em` so it scales with the surrounding font-size wherever it is dropped in.
 * Style mirrors the existing inline icons (SafetyScreen / Onboarding):
 * viewBox 24, stroke-width 2, round caps/joins.
 */
const PATHS: Record<WorkType, ReactNode> = {
  factory: (
    <>
      <path d="M2 20a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1V8l-7 5V8l-7 5V4a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1Z" />
      <path d="M7 18h1" />
      <path d="M12 18h1" />
      <path d="M17 18h1" />
    </>
  ),
  construction: (
    <>
      <path d="M2 18a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1v-1a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1z" />
      <path d="M10 10V6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v4" />
      <path d="M4 16v-3a6 6 0 0 1 6-6" />
      <path d="M20 16v-3a6 6 0 0 0-6-6" />
    </>
  ),
  agriculture: (
    <>
      <path d="M7 20h10" />
      <path d="M10 20c5.5-2.5.8-6.4 3-10" />
      <path d="M9.5 9.4c1.1.8 1.8 2.2 2.3 3.7-2 .4-3.5.4-4.8-.3-1.2-.6-2.3-1.9-3-4.2 2.8-.5 4.4 0 5.5.8z" />
      <path d="M14.1 6a7 7 0 0 0-1.1 4c1.9-.1 3.3-.6 4.3-1.4 1-1 1.6-2.3 1.7-4.6-2.7.1-4 1-4.9 2z" />
    </>
  ),
  fishery: (
    <>
      <path d="M6.5 12c.94-3.46 4.94-6 8.5-6 3.56 0 6.06 2.54 7 6-.94 3.47-3.44 6-7 6s-7.56-2.53-8.5-6Z" />
      <path d="M16 18a11 11 0 0 1 0-12" />
      <path d="M7 10.7C7 8 5.6 6 2.7 5.5c-1 1.5-1 5 .3 6.5-1.3 1.5-1.3 5-.3 6.5C5.6 18 7 16 7 13.3" />
      <path d="M11 10h.01" />
    </>
  ),
  food: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 12h18" />
      <path d="M12 5v7" />
    </>
  ),
  logistics: (
    <>
      <path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z" />
      <path d="M12 22V12" />
      <path d="m3.3 7 8.7 5 8.7-5" />
      <path d="m7.5 4.27 9 5.15" />
    </>
  ),
  restaurant: (
    <>
      <path d="M4 12h16a8 8 0 0 1-16 0Z" />
      <path d="M8 8V5" />
      <path d="M12 8V4" />
      <path d="M16 8V5" />
    </>
  ),
  cleaning: (
    <>
      <path d="M9 21h6a1 1 0 0 0 1-1v-8a3 3 0 0 0-3-3h-2a3 3 0 0 0-3 3v8a1 1 0 0 0 1 1Z" />
      <path d="M10 9V6h3v3" />
      <path d="M13 6h4l1 2.5" />
      <path d="M8.5 14.5h7" />
    </>
  ),
  caregiving: (
    <>
      <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z" />
      <path d="M3.5 12h4l1.5-3 3 6 1.5-3h4" />
    </>
  ),
  hotel: (
    <>
      <path d="M2 4v16" />
      <path d="M2 8h18a2 2 0 0 1 2 2v10" />
      <path d="M2 17h20" />
      <path d="M6 8v9" />
    </>
  ),
  services: (
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  ),
  other: (
    <>
      <rect x="2" y="7" width="20" height="14" rx="2" />
      <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
    </>
  ),
};

export function WorkTypeIcon({ type, className }: { type: WorkType; className?: string }) {
  return (
    <svg
      className={className ?? 'wt-ico'}
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {PATHS[type] ?? PATHS.other}
    </svg>
  );
}
