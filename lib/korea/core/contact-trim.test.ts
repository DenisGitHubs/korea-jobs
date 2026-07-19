// lib/korea/core/contact-trim.test.ts
//
// truncateContacts clamps contact_raw WITHOUT cutting a phone in half. Both write paths (the AI
// parser and the user-ad form) share it, so pin the exact contract: short passes through, an
// exact-max value is untouched, an over-long value is cut back to a whole-contact boundary, and a
// first contact longer than max is hard-cut.

import { describe, it, expect } from 'vitest';
import { truncateContacts } from './contact-trim.js';

const SEP = ' · '; // space, middle-dot U+00B7, space — must match the helper.

describe('truncateContacts', () => {
  it('returns a short string unchanged', () => {
    expect(truncateContacts('010-1111-2222', 300)).toBe('010-1111-2222');
  });

  it('returns a string that is EXACTLY max unchanged', () => {
    const v = 'x'.repeat(300);
    const out = truncateContacts(v, 300);
    expect(out).toBe(v);
    expect(out.length).toBe(300);
  });

  it('cuts a too-long string back to the last full " · " boundary within max', () => {
    const a = '010-1111-2222';
    const b = '010-3333-4444';
    const c = '010-5555-6666';
    const value = [a, b, c].join(SEP); // a · b · c
    const max = a.length + SEP.length + b.length + 5; // lands INSIDE c
    const out = truncateContacts(value, max);
    expect(out).toBe(`${a}${SEP}${b}`); // whole a + b, partial c dropped with its separator
    expect(out.length).toBeLessThanOrEqual(max);
    expect(out.endsWith(SEP)).toBe(false);
  });

  it('drops a partial trailing contact and keeps only whole ones (default max=300)', () => {
    const first = '010-1111-2222';
    const value = `${first}${SEP}${'8'.repeat(400)}`; // second contact overflows 300
    expect(truncateContacts(value)).toBe(first);
  });

  it('hard-cuts at max when the FIRST contact alone is longer than max', () => {
    const value = `${'9'.repeat(50)}${SEP}010-3333-4444`;
    const out = truncateContacts(value, 20);
    expect(out).toBe('9'.repeat(20));
    expect(out.length).toBe(20);
  });
});
