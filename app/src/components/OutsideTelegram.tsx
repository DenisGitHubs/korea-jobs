import { useCallback, useEffect, useState } from 'react';
import type { MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AppBar } from './AppBar';
import { LegalDoc } from './LegalDoc';
import { PRIVACY_POLICY } from '../content/legal/privacy';
import { REFERRAL_RULES } from '../content/legal/referral-rules';
import { SUPPORT_BOT } from '../lib/support';
import type { Lang } from '../i18n';

/** Direct link to the mini app, and to the bot itself — the two ways in. */
const APP_LINK = `https://t.me/${SUPPORT_BOT}/app`;
const BOT_LINK = `https://t.me/${SUPPORT_BOT}`;

function MarkIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect width="18" height="12" x="3" y="8" rx="2" />
      <path d="M8 8V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M3 13h18" />
    </svg>
  );
}

function PlaneIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 3 3 10.5l6.5 2.6L12 21l4-9z" />
    </svg>
  );
}

/** The three views this page can be in; they map 1:1 to real URLs. */
type View = 'home' | 'privacy' | 'rules';

function viewFromPath(pathname: string): View {
  if (pathname.startsWith('/privacy')) return 'privacy';
  if (pathname.startsWith('/rules')) return 'rules';
  return 'home';
}

/**
 * The page a plain browser gets INSTEAD of the whole app (see lib/launchEnv.ts).
 *
 * Inside Telegram nothing here ever mounts. Outside it there is no session, no
 * feed and nothing to load — so this is a complete, self-contained page: what
 * the app is, one big link into Telegram, and the published legal documents
 * under their own /privacy and /rules URLs, so the site is technically complete
 * rather than a stub. Deliberately static: no data fetching, no error states.
 */
export function OutsideTelegram() {
  const { t, i18n } = useTranslation();
  const [view, setView] = useState<View>(() => viewFromPath(window.location.pathname));

  // Keep the browser's own Back/Forward working between the page and the docs.
  useEffect(() => {
    const onPop = () => setView(viewFromPath(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const open = useCallback((next: View, path: string) => {
    window.history.pushState(null, '', path);
    setView(next);
    window.scrollTo(0, 0);
  }, []);

  // Real <a href> first: middle-click / "open in new tab" must keep working; a
  // plain left click is upgraded to an in-page switch (no reload, no flash).
  const onDocClick = useCallback(
    (next: View, path: string) => (e: MouseEvent<HTMLAnchorElement>) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      open(next, path);
    },
    [open],
  );

  const lang: Lang = i18n.language.startsWith('en') ? 'en' : 'ru';

  if (view !== 'home') {
    const doc = view === 'privacy' ? PRIVACY_POLICY[lang] : REFERRAL_RULES[lang];
    const title = view === 'privacy' ? t('privacy.title') : t('rules.title');
    return (
      <div className="outside outside--doc">
        <AppBar title={title} onBack={() => open('home', '/')} />
        <div className="outside__doc">
          <LegalDoc doc={doc} />
        </div>
      </div>
    );
  }

  return (
    <div className="outside">
      <main className="outside__card">
        <div className="outside__mark" aria-hidden>
          <MarkIcon />
        </div>
        <h1 className="outside__title">{t('app.title')}</h1>
        <p className="outside__sub">{t('outside.sub')}</p>
        <p className="outside__lead">{t('outside.lead')}</p>

        <ul className="outside__feats">
          <li className="outside__feat">{t('outside.feat1')}</li>
          <li className="outside__feat">{t('outside.feat2')}</li>
          <li className="outside__feat">{t('outside.feat3')}</li>
        </ul>

        <a className="btn btn--block outside__cta" href={APP_LINK} target="_blank" rel="noopener noreferrer">
          <PlaneIcon />
          {t('outside.cta')}
        </a>

        <p className="outside__hint">
          {t('outside.botHint')}{' '}
          <a className="outside__link" href={BOT_LINK} target="_blank" rel="noopener noreferrer">
            @{SUPPORT_BOT}
          </a>
        </p>

        <nav className="outside__links" aria-label={t('outside.docs')}>
          <a className="outside__link" href="/privacy" onClick={onDocClick('privacy', '/privacy')}>
            {t('privacy.title')}
          </a>
          <span className="outside__sep" aria-hidden>
            ·
          </span>
          <a className="outside__link" href="/rules" onClick={onDocClick('rules', '/rules')}>
            {t('rules.title')}
          </a>
        </nav>

        <p className="outside__note">{t('outside.note')}</p>
      </main>
    </div>
  );
}
