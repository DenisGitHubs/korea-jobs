import { useCallback, useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { postEvent, shareMessage } from '@telegram-apps/sdk-react';
import { api, ApiError } from '../shared/api/client';
import type { VacancyContact, VacancyView } from '../shared/types/api';
import { feeKey, genderKey, regionKey, visaKey, workTypeKey } from '../shared/labels';
import { useBackButton } from '../hooks/useBackButton';
import { useSettingsStore } from '../store/settingsStore';
import { useSubscriptionStore } from '../store/subscriptionStore';
import { applySaveToCaches, revertSaveInCaches } from '../store/feedStore';
import { cityLabel } from '../lib/cities';
import { buildShareStartParam, buildVacancyShareLink, loadReferral } from '../lib/shareLink';
import { isStale, timeAgo } from '../lib/format';
import { AppBar } from '../components/AppBar';
import { Loading } from '../components/Loading';
import { EmptyState } from '../components/EmptyState';
import { WorkTypeBadge } from '../components/WorkTypeBadge';
import { HeartIcon } from '../components/VacancyCard';
import { ContactLines } from '../components/ContactLines';
import { IconSearch } from '../components/icons/StateIcons';
import { findPhone, findTelegramUsername, splitContacts } from '../lib/contacts';

function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
    </svg>
  );
}

type ContactState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; contact: VacancyContact | null }
  | { status: 'error'; message: string };

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
  const location = useLocation();
  const { id = '' } = useParams();
  // True when this card was opened from a shared/push deep link (App sets it). Used to
  // degrade a dead link (hidden/deleted vacancy) silently to the feed, with no error.
  const deepLinkEntry = Boolean((location.state as { deepLink?: boolean } | null)?.deepLink);
  const lang = useSettingsStore((s) => s.lang);
  const isReal = useSettingsStore((s) => s.isReal);
  // Remaining daily contact reveals (from /me, refreshed by each reveal response).
  // null = backend has not shipped the field → hide the hint entirely.
  const revealsLeft = useSubscriptionStore((s) => s.revealsLeft);
  const setRevealsLeft = useSubscriptionStore((s) => s.setRevealsLeft);

  const [vacancy, setVacancy] = useState<VacancyView | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [contact, setContact] = useState<ContactState>({ status: 'idle' });
  const [copied, setCopied] = useState(false);
  const [reported, setReported] = useState(false);
  const [saved, setSaved] = useState(false);
  // Transient banner for the browser/mock share fallback ("link copied"). Null = hidden.
  const [shareToast, setShareToast] = useState<string | null>(null);
  // "Share this vacancy" nudge shown once, right after a successful reveal, at a
  // frequency cap (see maybeShowShareNudge). Card-local; ✕ hides only this instance.
  const [showNudge, setShowNudge] = useState(false);

  // Warm the referral code/link once (memoized) so the Share tap opens the native
  // sheet instantly instead of waiting on a first GET /referral round-trip.
  useEffect(() => {
    void loadReferral();
  }, []);

  // Auto-dismiss the share toast.
  useEffect(() => {
    if (shareToast == null) return;
    const tid = window.setTimeout(() => setShareToast(null), 2200);
    return () => window.clearTimeout(tid);
  }, [shareToast]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setNotFound(false);
    // New card → drop any leftover nudge from the previous listing.
    setShowNudge(false);
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

  // Distinguish the three failure modes the reveal can hit: 429 → the shared
  // daily budget is spent; any other network/server error → generic retry; a
  // real {contact:null} is NOT an error (falls into the 'done' branch below and
  // shows "no contact"). Mirrors the RawCard reveal handling.
  // Decide whether to show the "share this vacancy" nudge after a successful reveal.
  // Counter increments on EVERY successful reveal (independent of whether we show) so
  // the frequency cap is stable; we show only on the 1st reveal and every 4th after,
  // and at most once per session (sessionStorage). A referral code already rides in
  // the shared vacancy card, so nudging to share the vacancy also spreads the app.
  const maybeShowShareNudge = useCallback(() => {
    try {
      const count = (Number.parseInt(localStorage.getItem('kj:shareNudgeCount') ?? '0', 10) || 0) + 1;
      localStorage.setItem('kj:shareNudgeCount', String(count));
      const dueByFrequency = count === 1 || count % 4 === 0;
      const shownThisSession = sessionStorage.getItem('kj:shareNudgeShownSession') === '1';
      if (dueByFrequency && !shownThisSession) {
        sessionStorage.setItem('kj:shareNudgeShownSession', '1');
        setShowNudge(true);
      }
    } catch {
      /* storage blocked — skip the nudge */
    }
  }, []);

  const revealContact = useCallback(() => {
    setContact({ status: 'loading' });
    api
      .vacancyContact(id)
      .then((r) => {
        setContact({ status: 'done', contact: r.contact });
        // Keep the shared counter in sync with the server's post-reveal budget.
        setRevealsLeft(r.reveals_left);
        // A real contact was revealed → maybe surface the share nudge.
        if (r.contact != null) maybeShowShareNudge();
      })
      .catch((e: unknown) => {
        const http = e instanceof ApiError ? e.http : 0;
        // 429 = the daily budget is spent; reflect it locally so the soft limit
        // notice replaces the button on the next render.
        if (http === 429) setRevealsLeft(0);
        setContact({
          status: 'error',
          message: http === 429 ? t('vacancy.errorLimit') : t('vacancy.errorGeneric'),
        });
      });
  }, [id, t, setRevealsLeft, maybeShowShareNudge]);

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

  // The CURRENT share path — kept byte-for-byte in behaviour and used as the graceful
  // fallback below. Reuses the exact ReferralScreen mechanism: real client opens
  // Telegram's native "share to a chat" sheet via `web_app_open_tg_link` on
  // /share/url?url=…&text=…; browser/mock (or a failed postEvent) copies the link so
  // the preview still works. The link carries a combined startapp (vacancy id + my
  // referral code) — the app deep-navigates to the card, the backend binds the referral.
  const shareFallback = useCallback(async () => {
    const v = vacancy;
    if (!v) return;
    const ref = await loadReferral();
    const startParam = buildShareStartParam(v.id, ref?.code);
    // Targeted combined link when we have both a UUID id and the server link base;
    // otherwise fall back to the plain personal referral link (still useful, e.g. mock).
    const link = startParam && ref?.link ? buildVacancyShareLink(ref.link, startParam) : (ref?.link ?? null);
    if (!link) {
      setShareToast(t('vacancy.shareUnavailable'));
      return;
    }

    // Short human subject for the pitch: "City · Work".
    const cities = v.cities?.length ? v.cities : v.city ? [v.city] : [];
    const cityStr = cities.map((c) => cityLabel(c, lang, t)).join(' · ');
    const subject = [cityStr, t(workTypeKey(v.work_type))].filter(Boolean).join(' · ');
    const text = t('vacancy.shareText', { subject });

    const pathFull = `/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
    if (isReal) {
      try {
        postEvent('web_app_open_tg_link', { path_full: pathFull });
        return;
      } catch {
        /* fall through to copy */
      }
    }
    try {
      await navigator.clipboard?.writeText(link);
      setShareToast(t('vacancy.shareCopied'));
    } catch {
      setShareToast(link);
    }
  }, [vacancy, isReal, lang, t]);

  // Share THIS vacancy. Preferred path (Bot API 8.0+): ask the backend to mint a
  // "prepared inline message" and hand it to Telegram's native rich-card share sheet
  // via WebApp.shareMessage. This DEGRADES SILENTLY to the current link-share
  // (`shareFallback`) on every failure mode, so nothing regresses on older clients:
  //   • shareMessage.isAvailable() === false  → client < 8.0 / unsupported / no SDK env
  //     (the endpoint is never even called), or
  //   • the backend opts out ({ fallback: true }) or returns no preparedMessageId, or
  //   • the endpoint errors / the network fails, or
  //   • the native share dialog rejects (shareMessage promise throws).
  // The referral binding rides inside the prepared card server-side; the fallback link
  // still carries the combined startapp (vacancy id + ref code) as before.
  const shareVacancy = useCallback(async () => {
    const v = vacancy;
    if (!v) return;
    // Feature-detect the 8.0 prepared-message API (this also gates on a known TMA env
    // + an initialized SDK). Anything short of "available" → straight to the fallback.
    if (shareMessage.isAvailable()) {
      try {
        const prep = await api.sharePrepare({ vacancyId: v.id });
        if (prep.ok && !prep.fallback && prep.preparedMessageId) {
          // Resolves on `prepared_message_sent`, rejects on `prepared_message_failed`
          // (or a dismissed dialog) → the catch below falls back.
          await shareMessage(prep.preparedMessageId);
          setShareToast(t('vacancy.shareSent'));
          return;
        }
      } catch {
        /* backend/network/dialog failure → fall through to the link-share */
      }
    }
    await shareFallback();
  }, [vacancy, shareFallback, t]);

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
  // Resolved city list (multi-city first, `city` fallback) computed once — the hero
  // and the source-link condition both read it. Empty === city not specified.
  const cityList = vacancy
    ? vacancy.cities?.length
      ? vacancy.cities
      : vacancy.city
        ? [vacancy.city]
        : []
    : [];
  // Region-level fallback when the offer has no city. `noCity` (drives the
  // "open in channel — clarify location" hint) is decided by cities ONLY, so a
  // region label never suppresses that hint.
  const regionList = vacancy?.regions ?? [];
  const noCity = cityList.length === 0;

  // Daily reveal budget. Show the thin "reveals left" hint only when the backend
  // gave us a positive number. The soft "limit reached" notice replaces the button
  // when the budget is spent AND this offer was never revealed (repeat reveals are
  // free, so an already-revealed contact stays openable even at zero).
  const alreadyRevealed = Boolean(vacancy?.is_revealed);
  const revealHintVisible = typeof revealsLeft === 'number' && revealsLeft > 0;
  const limitReached = typeof revealsLeft === 'number' && revealsLeft <= 0 && !alreadyRevealed;

  return (
    <div className="app">
      <AppBar
        title={t('vacancy.title')}
        onBack={goBack}
        right={
          vacancy ? (
            <>
              <button
                className="appbar__btn appbar__btn--icon"
                onClick={shareVacancy}
                title={t('vacancy.share')}
                aria-label={t('vacancy.shareAria')}
              >
                <ShareIcon />
              </button>
              <button
                className={`appbar__btn appbar__btn--icon ${saved ? 'appbar__btn--fav' : ''}`}
                onClick={toggleSave}
                aria-pressed={saved}
                aria-label={t(saved ? 'feed.unsave' : 'feed.save')}
              >
                <HeartIcon filled={saved} />
              </button>
            </>
          ) : undefined
        }
      />
      <div className="screen">
        {shareToast != null ? (
          <div className="ref-toast" role="status">
            {shareToast}
          </div>
        ) : null}
        {loading ? (
          <Loading text={t('common.loading')} />
        ) : notFound && deepLinkEntry ? (
          // Dead shared/push link (vacancy hidden or deleted) → slip back to the feed
          // silently, no error screen.
          <Navigate to="/feed" replace />
        ) : notFound || !vacancy ? (
          <EmptyState icon={<IconSearch />} title={t('common.error')} actionLabel={t('nav.feed')} onAction={goBack} />
        ) : (
          <>
            <div className="hero">
              <h1 className="hero__title">
                {cityList.length
                  ? cityList.map((c) => cityLabel(c, lang, t)).join(' · ')
                  : regionList.length
                    ? `${regionList.map((r) => t(regionKey(r))).join(' · ')} · ${t('city.regionSuffix')}`
                    : t('city.unspecified')}
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

            {/* Compact details: headline facts (employer, visa) span the full row;
                the short yes/no pairs pack into a 2-column grid to keep the block
                roughly half the height of the old one-row-per-field layout. */}
            <div className="section" style={{ marginBottom: 16 }}>
              <div className="dl-grid">
                {vacancy.employer ? (
                  <div className="dl-grid__cell dl-grid__cell--wide">
                    <span className="dl__k">{t('vacancy.employer')}</span>
                    <span className="dl__v">{vacancy.employer}</span>
                  </div>
                ) : null}
                <div className="dl-grid__cell dl-grid__cell--wide">
                  <span className="dl__k">{t('vacancy.visa')}</span>
                  <span className="dl__v">
                    {vacancy.visa_types.length
                      ? vacancy.visa_types.map((v) => t(visaKey(v))).join(', ')
                      : t('vacancy.notStated')}
                  </span>
                </div>
                <div className="dl-grid__cell">
                  <span className="dl__k">{t('vacancy.gender')}</span>
                  <span className="dl__v">{t(genderKey(vacancy.gender))}</span>
                </div>
                <div className="dl-grid__cell">
                  <span className="dl__k">{t('vacancy.fee')}</span>
                  <span className="dl__v">{t(feeKey(vacancy.placement_fee))}</span>
                </div>
                <div className="dl-grid__cell">
                  <span className="dl__k">{t('vacancy.housing')}</span>
                  <span className="dl__v">{threeState(vacancy.has_housing)}</span>
                </div>
                <div className="dl-grid__cell">
                  <span className="dl__k">{t('vacancy.meals')}</span>
                  <span className="dl__v">{threeState(vacancy.has_meals)}</span>
                </div>
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

            {/* Source-channel link + contact. The backend sends `source_post_url`
                when the channel is public AND the listing either has no direct
                contact OR its city is unresolved — so the button can appear
                alongside a real contact (with a "no city" hint above it). The
                contact itself is revealed only on explicit action (anti-harvesting). */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {vacancy.source_post_url && (noCity || !vacancy.has_contact) ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {noCity ? (
                    <div className="muted" style={{ padding: '0 4px' }}>
                      {t('vacancy.openInChannelNoCity')}
                    </div>
                  ) : null}
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
              ) : null}

              {vacancy.has_contact ? (
                contact.status === 'idle' || contact.status === 'error' ? (
                  limitReached ? (
                    // Budget spent and never revealed → a gentle, non-error notice
                    // (soft --kj-hint styling) instead of the button.
                    <div className="reveal-limit">{t('vacancy.errorLimit')}</div>
                  ) : (
                    <>
                      <button className="btn btn--primary btn--block" onClick={revealContact}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                          <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z" />
                        </svg>
                        {/* Already revealed before → the button reads "contact opened"; a
                            repeat reveal is free (backend serves it again). */}
                        {vacancy.is_revealed ? t('vacancy.revealed') : t('vacancy.showContact')}
                      </button>
                      {/* Thin, non-shouting hint: how many reveals are left today. */}
                      {revealHintVisible ? (
                        <div className="reveal-hint">{t('vacancy.revealsLeft', { count: revealsLeft as number })}</div>
                      ) : null}
                      {contact.status === 'error' ? <div className="reveal-error">{contact.message}</div> : null}
                    </>
                  )
                ) : contact.status === 'loading' ? (
                  <Loading text={t('vacancy.loadingContact')} />
                ) : contact.contact ? (
                  splitContacts(contact.contact.value).length > 1 ? (
                    // Several contacts packed into one field → one row each.
                    <ContactLines value={contact.contact.value} onTelegram={writeTelegramUsername} />
                  ) : (
                    (() => {
                      const c = contact.contact!;
                      const isTg = isTelegramContact(c);
                      // Dial-able phone for the primary "call" action: kind=phone or any
                      // phone-like value. Telegram/WhatsApp are excluded so their own
                      // action (write / open app) stays the primary one.
                      const phone = isTg || c.kind === 'whatsapp' ? null : findPhone(c.value);
                      const openHref = contactHref(c); // wa.me / t.me / null (phone handled above)
                      return (
                        <div className="contact">
                          <div className="contact__kind">{t(`contactKind.${c.kind}`)}</div>
                          <div className={`contact__value${phone ? ' contact__value--nowrap' : ''}`}>
                            {c.value}
                          </div>
                          <div className="contact__actions">
                            {isTg ? (
                              <button className="btn btn--tg" onClick={() => writeTelegram(c)}>
                                {t('contact.writeTelegram')}
                              </button>
                            ) : phone ? (
                              <a className="btn btn--tg" href={`tel:${phone}`}>
                                {t('contact.call')}
                              </a>
                            ) : openHref ? (
                              <a className="btn btn--tg" href={openHref} target="_blank" rel="noreferrer">
                                {t('vacancy.open')}
                              </a>
                            ) : null}
                            <button className="btn btn--secondary" onClick={() => copy(c.value)}>
                              {copied ? t('vacancy.copied') : t('vacancy.copy')}
                            </button>
                          </div>
                        </div>
                      );
                    })()
                  )
                ) : (
                  <div className="muted" style={{ padding: '4px 4px' }}>
                    {t('vacancy.noContact')}
                  </div>
                )
              ) : vacancy.source_post_url ? null : (
                // No direct contact and no source link → nothing to open.
                <div className="muted" style={{ padding: '4px 4px' }}>
                  {t('vacancy.noContact')}
                </div>
              )}
            </div>

            {/* Share nudge — appears right after a real contact is revealed, capped by
                frequency + once-per-session. "Скинуть" reuses the exact AppBar share
                (rich card + link fallback, referral code inside), then hides itself. */}
            {showNudge && contact.status === 'done' && contact.contact != null ? (
              <div className="nudge-share" role="note">
                <span className="nudge-share__icon" aria-hidden>
                  👋
                </span>
                <span className="nudge-share__text">{t('vacancy.shareNudge.text')}</span>
                <button
                  className="nudge-share__cta"
                  onClick={() => {
                    void shareVacancy();
                    setShowNudge(false);
                  }}
                >
                  {t('vacancy.shareNudge.cta')}
                </button>
                <button
                  className="nudge-share__close"
                  onClick={() => setShowNudge(false)}
                  aria-label={t('vacancy.shareNudge.close')}
                >
                  ✕
                </button>
              </div>
            ) : null}

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
