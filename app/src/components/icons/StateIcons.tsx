/**
 * Shared line icons for empty states, the contact-reveal marker and status
 * screens. All are 24×24, single-stroke, `currentColor` — so they inherit the
 * host's colour and sit consistently with the rest of the UI's line iconography
 * (replaces the old emoji glyphs in EmptyState).
 */
const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

/** Search / magnifier — "nothing found", relax the filter. */
export function IconSearch() {
  return (
    <svg {...base}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.4-3.4" />
    </svg>
  );
}

/** Warning triangle — error / rejected / unverified states. */
export function IconWarn() {
  return (
    <svg {...base}>
      <path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

/** Check inside a circle — success / all-clear states. */
export function IconCheckCircle() {
  return (
    <svg {...base}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </svg>
  );
}

/** Bare check — the small "contact opened" marker on cards. */
export function IconCheck() {
  return (
    <svg {...base}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/** Clock — pending / in-review states. */
export function IconClock() {
  return (
    <svg {...base}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </svg>
  );
}

/** Document with a pencil — "no ads yet" empty state. */
export function IconDoc() {
  return (
    <svg {...base}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-9" />
      <path d="M8 8h4" />
      <path d="M8 12h6" />
      <path d="M8 16h3" />
      <path d="m17.5 3.5 3 3L15 12l-3 .5.5-3z" />
    </svg>
  );
}

/** Map pin with a dash instead of a dot — "city not specified" (muted). */
export function IconGeoUnknown() {
  return (
    <svg {...base}>
      <path d="M12 21s7-5.5 7-11a7 7 0 0 0-14 0c0 5.5 7 11 7 11z" />
      <path d="M9 10h6" />
    </svg>
  );
}

/** Handshake-ish paper plane — "message sent" (partners) state. */
export function IconSent() {
  return (
    <svg {...base}>
      <path d="M21 4 3 11l6 2.5L21 4z" />
      <path d="M21 4 12 21l-3-7.5" />
    </svg>
  );
}
