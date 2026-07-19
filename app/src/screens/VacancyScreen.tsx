import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { postEvent } from '@telegram-apps/sdk-react';
import { api, ApiError } from '../shared/api/client';
import type { VacancyContact, VacancyView } from '../shared/types/api';
import { feeKey, genderKey, visaKey } from '../shared/labels';
import { useBackButton } from '../hooks/useBackButton';
import { useSettingsStore } from '../store/settingsStore';
import { applySaveToCaches, revertSaveInCaches } from '../store/feedStore';
import { localized } from '../lib/localized';
import { isStale, timeAgo } from '../lib/format';
import { AppBar } from '../components/AppBar';
import { Loading } from '../components/Loading';
import { EmptyState } from '../components/EmptyState';
import { WorkTypeBadge } from '../components/WorkTypeBadge';
import { HeartIcon } from '../components/VacancyCard';
import { ContactLines } from '../components/ContactLines';
import { findTelegramUsername, splitContacts } from '../lib/contacts';

function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

type ContactState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; contact: VacancyContact | null };

function contactHref(c: VacancyContact): string | null {
  switch (c.kind) {
    case 'phone':
      return `tel:${c.value.replace(/[^0-9+]/g, '')}`;
    case 'telegram':
      return `https://t.me/${c.value.replace(/^@/, '')}`;
    case 'whatsapp':
      return `https://wa.me/${c.value.replace(/[^0-9]/g, '')}`;
    default:
      return null;
  }
}

/** Max chars of the listing description we prefill into the Telegram message. */
const TG_MSG_MAX = 700;

/** Value looks like a Telegram handle/link (used to detect tg for non-'telegram' kinds). */
const TG_LIKE_RE = /^\s*(?:https?:\/\/)?(?:t\.me\/|@|tg:\/\/resolve\?domain=)/i;

/** True when we can open a Telegram chat with this contact. */
function isTelegramContact(c: VacancyContact): boolean {
  if (c.kind === 'telegram') return findTelegramUsername(c.value) !== null;
  return TG_LIKE_RE.test(c.value) && findTelegramUsername(c.value) !== null;
}

export default function VacancyScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { id = '' } = useParams();
  const lang = useSettingsStore((s) => s.lang);
  const isReal = useSettingsStore((s) => s.isReal);

  const [vacancy, setVacancy] = useState<VacancyView | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [contact, setContact] = useState<ContactState>({ status: 'idle' });
  const [copied, setCopied] = useState(false);
  const [reported, setReported] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setNotFound(false);
    api
      .vacancy(id)
      .then((v) => {
        if (alive) setVacancy(v);
      })
      .catch((e: unknown) => {
        if (alive) setNotFound(e instanceof ApiError && e.http === 404);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [id]);

  const goBack = useCallback(() => navigate('/feed'), [navigate]);
  useBackButton(true, goBack);

  // Sync the bookmark state from the loaded vacancy.
  useEffect(() => {
    if (vacancy) setSaved(vacancy.is_saved);
  }, [vacancy]);

  // Optimistic bookmark toggle. On error, revert BOTH local state and the shared
  // feed caches (identical to FeedScreen), so the heart and the Saved list never
  // drift from the server.
  const toggleSave = useCallback(() => {
    const next = !saved;
    setSaved(next);
    applySaveToCaches(id, next);
    (next ? api.saveVacancy(id) : api.unsaveVacancy(id)).catch(() => {
      setSaved(saved);
      revertSaveInCaches(id, saved);
    });
  }, [saved, id]);

  const revealContact = useCallback(() => {
    setContact({ status: 'loading' });
    api
      .vacancyContact(id)
      .then((r) => setContact({ status: 'done', contact: r.contact }))
      .catch(() => setContact({ status: 'done', contact: null }));
  }, [id]);

  const copy = useCallback((value: string) => {
    void navigator.clipboard
      ?.writeText(value)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        /* clipboard blocked — ignore */
      });
  }, []);

  const report = useCallback(() => {
    setReported(true);
    api.reportVacancy(id).catch(() => {
      /* best effort */
    });
  }, [id]);

  // Open the source-channel post for listings with no direct contact. Reuses the
  // exact same relative-path mechanism as writeTelegram: raw `web_app_open_tg_link`
  // in the real client (bypasses the SDK's desktop window.open fallback, tma.js #712),
  // plain t.me link in the browser. `path_full` is everything after `t.me`.
  const openSourcePost = useCallback(
    (url: string) => {
      const pathFull = url.replace(/^https?:\/\/t\.me/i, '');
      // Defensive: if it wasn't a t.me URL, open it as-is (backend guarantees t.me).
      if (pathFull === url) {
        window.open(url, '_blank');
        return;
      }
      try {
        if (isReal) {
          postEvent('web_app_open_tg_link', { path_full: pathFull });
        } else {
          window.open(`https://t.me${pathFull}`, '_blank');
        }
      } catch {
        window.open(`https://t.me${pathFull}`, '_blank');
      }
    },
    [isReal],
  );

  // Open a Telegram chat with the author (by bare username), prefilling a message
  // referencing this listing. Real client: raw `web_app_open_tg_link` event
  // (relative path) — bypasses the SDK's desktop/macOS window.open fallback
  // (tma.js #712). Browser: plain t.me link. Used both by the single-contact
  // block and by each Telegram row of the multi-contact list.
  const writeTelegramUsername = useCallback(
    (username: string) => {
      if (!username || !vacancy) return;
      const full = vacancy.description;
      const desc = full.length > TG_MSG_MAX ? `${full.slice(0, TG_MSG_MAX)} …` : full;
      const encoded = encodeURIComponent(`${t('contact.writeTelegramPrefix')} ${desc}`);
      const pathFull = `/${username}?text=${encoded}`;
      try {
        if (isReal) {
          postEvent('web_app_open_tg_link', { path_full: pathFull });
        } else {
          window.open(`https://t.me${pathFull}`, '_blank');
        }
      } catch {
        window.open(`https://t.me${pathFull}`, '_blank');
      }
    },
    [vacancy, isReal, t],
  );

  const writeTelegram = useCallback(
    (c: VacancyContact) => {
      const username = findTelegramUsername(c.value);
      if (username) writeTelegramUsername(username);
    },
    [writeTelegramUsername],
  );

  const threeState = (v: boolean | null): string =>
    v === true ? t('common.yes') : v === false ? t('common.no') : t('vacancy.notStated');

  const isRepost = Boolean((vacancy as { repost?: boolean } | null)?.repost);

  return (
    <div className="app">
      <AppBar
        title={t('vacancy.title')}
        onBack={goBack}
        right={
          vacancy ? (
            <button
              className={`appbar__btn appbar__btn--icon ${saved ? 'appbar__btn--fav' : ''}`}
              onClick={toggleSave}
              aria-pressed={saved}
              aria-label={t(saved ? 'feed.unsave' : 'feed.save')}
            >
              <HeartIcon filled={saved} />
            </button>
          ) : undefined
        }
      />
      <div className="screen">
        {loading ? (
          <Loading text={t('common.loading')} />
        ) : notFound || !vacancy ? (
          <EmptyState emoji="🔎" title={t('common.error')} actionLabel={t('nav.feed')} onAction={goBack} />
        ) : (
          <>
            <div className="hero">
              <h1 className="hero__title">
                {vacancy.city ? localized(vacancy.city.name, lang) : t('region.other')}
              </h1>
              <p className="hero__sub">{timeAgo(vacancy.posted_at, t)}</p>
              {isStale(vacancy.posted_at) ? (
                <p className="hero__note">{t('vacancy.mayBeTaken')}</p>
              ) : null}
            </div>

            <div className="card__badges" style={{ marginBottom: 16 }}>
              <WorkTypeBadge type={vacancy.work_type} />
              <span className="badge badge--gender">{t(genderKey(vacancy.gender))}</span>
              {vacancy.source_kind === 'user' ? (
                <span className="badge badge--source">{t('vacancy.fromUser')}</span>
              ) : null}
              {isRepost ? <span className="badge badge--repost">{t('vacancy.repost')}</span> : null}
            </div>

            <div className="section" style={{ marginBottom: 16 }}>
              {vacancy.employer ? (
                <div className="dl">
                  <span className="dl__k">{t('vacancy.employer')}</span>
                  <span className="dl__v">{vacancy.employer}</span>
                </div>
              ) : null}
              <div className="dl">
                <span className="dl__k">{t('vacancy.gender')}</span>
                <span className="dl__v">{t(genderKey(vacancy.gender))}</span>
              </div>
            </div>

            <div className="section" style={{ marginBottom: 16 }}>
              <div className="dl">
                <span className="dl__k">{t('vacancy.visa')}</span>
                <span className="dl__v">
                  {vacancy.visa_types.length
                    ? vacancy.visa_types.map((v) => t(visaKey(v))).join(', ')
                    : t('vacancy.notStated')}
                </span>
              </div>
              <div className="dl">
                <span className="dl__k">{t('vacancy.fee')}</span>
                <span className="dl__v">{t(feeKey(vacancy.placement_fee))}</span>
              </div>
              <div className="dl">
                <span className="dl__k">{t('vacancy.housing')}</span>
                <span className="dl__v">{threeState(vacancy.has_housing)}</span>
              </div>
              <div className="dl">
                <span className="dl__k">{t('vacancy.meals')}</span>
                <span className="dl__v">{threeState(vacancy.has_meals)}</span>
              </div>
            </div>

            <div className="section" style={{ marginBottom: 16 }}>
              <div className="dl">
                <span className="dl__k">{t('vacancy.description')}</span>
                <span className="dl__v" style={{ whiteSpace: 'pre-wrap' }}>
                  {vacancy.description}
                </span>
              </div>
            </div>

            {/* Contact is revealed only on explicit action (anti-harvesting).
                No direct contact but a public source post → link to the original. */}
            {!vacancy.has_contact ? (
              vacancy.source_post_url ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <button
                    className="btn btn--tg btn--block"
                    onClick={() => openSourcePost(vacancy.source_post_url!)}
                  >
                    {t('vacancy.openInChannel')}
                  </button>
                  <div className="muted" style={{ padding: '0 4px' }}>
                    {t('vacancy.openInChannelNote')}
                  </div>
                </div>
              ) : (
                <div className="muted" style={{ padding: '4px 4px' }}>
                  {t('vacancy.noContact')}
                </div>
              )
            ) : contact.status === 'idle' ? (
              <button className="btn btn--primary btn--block" onClick={revealContact}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z" />
                </svg>
                {t('vacancy.showContact')}
              </button>
            ) : contact.status === 'loading' ? (
              <Loading text={t('vacancy.loadingContact')} />
            ) : contact.contact ? (
              splitContacts(contact.contact.value).length > 1 ? (
                // Several contacts packed into one field → one row each.
                <ContactLines value={contact.contact.value} onTelegram={writeTelegramUsername} />
              ) : (
                <div className="contact">
                  <div>
                    <div className="contact__kind">{t(`contactKind.${contact.contact.kind}`)}</div>
                    <div className="contact__value">{contact.contact.value}</div>
                  </div>
                  {isTelegramContact(contact.contact) ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <button
                        className="btn btn--tg btn--block"
                        onClick={() => writeTelegram(contact.contact!)}
                      >
                        {t('contact.writeTelegram')}
                      </button>
                      <button className="btn btn--secondary" onClick={() => copy(contact.contact!.value)}>
                        {copied ? t('vacancy.copied') : t('vacancy.copy')}
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="btn btn--secondary" onClick={() => copy(contact.contact!.value)}>
                        {copied ? t('vacancy.copied') : t('vacancy.copy')}
                      </button>
                      {contactHref(contact.contact) ? (
                        <a
                          className="btn btn--tg"
                          href={contactHref(contact.contact) ?? undefined}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {t('vacancy.open')}
                        </a>
                      ) : null}
                    </div>
                  )}
                </div>
              )
            ) : (
              <div className="muted" style={{ padding: '4px 4px' }}>
                {t('vacancy.noContact')}
              </div>
            )}

            {/* Trust card + link to the full safety guide (replaces the old prepay note). */}
            <div className="trust" style={{ marginTop: 16 }}>
              <span className="trust__ico">
                <ShieldIcon />
              </span>
              <div>
                <div className="trust__t">{t('safety.trustCard.title')}</div>
                <div className="trust__s">{t('safety.trustCard.body')}</div>
              </div>
            </div>
            <button className="safe-cta" onClick={() => navigate('/safety')}>
              {t('safety.link')} →
            </button>

            <div className="report">
              {reported ? (
                <span className="muted">{t('vacancy.reported')}</span>
              ) : (
                <button className="report__btn" onClick={report}>
                  {t('vacancy.report')}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
