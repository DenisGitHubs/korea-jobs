import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../shared/api/client';
import type { VisaType, WorkType } from '../shared/types/api';
import { VISA_TYPES, WORK_TYPES, visaKey, workTypeKey } from '../shared/labels';
import { useShareApp } from '../hooks/useShareApp';
import { loadReferral } from '../lib/shareLink';
import { SUPPORT_BOT, openSupportChat } from '../lib/support';
import { WorkTypeIcon } from '../components/icons/WorkTypeIcon';
import { toSubscription, useSubscriptionStore } from '../store/subscriptionStore';
import { useSettingsStore } from '../store/settingsStore';
import { useUiStore } from '../store/uiStore';
import { useCities } from '../hooks/useCities';
import { citiesSummary } from '../lib/cities';
import type { Lang } from '../i18n';
import type { ThemeMode } from '../lib/theme';
import { AppBar } from '../components/AppBar';
import { Switch } from '../components/Switch';
import { Segmented } from '../components/Segmented';
import { ChipSelect, type ChipOption } from '../components/ChipSelect';
import { Modal } from '../components/Modal';

/**
 * How many job MESSAGES a day the bot may send (Seoul time). `null` = no limit.
 * One message can carry several offers, so this caps the pings, not the vacancies.
 */
const CAP_CHOICES: ReadonlyArray<number | null> = [5, 10, 20, 50, null];
/** Chip value for "no limit" (chips are string-keyed). */
const CAP_OFF = 'off';

function capToChip(cap: number | null): string {
  return cap === null ? CAP_OFF : String(cap);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((x) => sb.has(x));
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

export default function SettingsScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const lang = useSettingsStore((s) => s.lang);
  const setLang = useSettingsStore((s) => s.setLang);
  const isReal = useSettingsStore((s) => s.isReal);
  const themeMode = useSettingsStore((s) => s.themeMode);
  const setThemeMode = useSettingsStore((s) => s.setThemeMode);
  const setTourReplay = useUiStore((s) => s.setTourReplay);
  const { bySlug } = useCities();
  // Explicit "Share the app" action (same rich-card + link fallback as the referral
  // screen, via the shared hook). Warm the referral info once so the fallback link
  // is ready on first tap.
  const { shareApp, shareToast } = useShareApp();
  useEffect(() => {
    void loadReferral();
  }, []);

  const apply = useSubscriptionStore((s) => s.apply);
  const sCities = useSubscriptionStore((s) => s.citySlugs);
  const sRegions = useSubscriptionStore((s) => s.regionSlugs);
  const sNoCity = useSubscriptionStore((s) => s.noCity);
  const sWork = useSubscriptionStore((s) => s.workTypes);
  const sVisa = useSubscriptionStore((s) => s.visaTypes);
  const sFee = useSubscriptionStore((s) => s.placementFee);
  const sHousing = useSubscriptionStore((s) => s.requireHousing);
  const sMeals = useSubscriptionStore((s) => s.requireMeals);
  const sNotify = useSubscriptionStore((s) => s.notify);
  const sDigest = useSubscriptionStore((s) => s.digestEnabled);
  const sCap = useSubscriptionStore((s) => s.notifyDailyCap);

  const [work, setWork] = useState<WorkType[]>(() => sWork);
  const [visa, setVisa] = useState<VisaType[]>(() => sVisa);
  const [paid, setPaid] = useState<'free' | 'paid' | null>(() =>
    sFee === 'free' || sFee === 'paid' ? sFee : null,
  );
  const [housing, setHousing] = useState<boolean>(() => sHousing === true);
  const [meals, setMeals] = useState<boolean>(() => sMeals === true);
  const [notify, setNotify] = useState<boolean>(() => sNotify);
  const [digest, setDigest] = useState<boolean>(() => sDigest);
  // Display value: an UNKNOWN cap (a backend that does not report the field yet)
  // shows as "no limit" — that is what actually happens today.
  const [cap, setCap] = useState<number | null>(() => sCap ?? null);
  // Whether the user actually touched the chips. Only then may an unknown cap be
  // written; otherwise the save omits the field and the server keeps its value.
  const [capTouched, setCapTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  // Info popup shown every time the user picks the 'auto' theme, explaining the
  // Korean-time schedule. Purely informational — the mode is applied instantly.
  const [autoInfo, setAutoInfo] = useState(false);

  const onThemeChange = useCallback(
    (m: ThemeMode) => {
      setThemeMode(m);
      if (m === 'auto') setAutoInfo(true);
    },
    [setThemeMode],
  );

  // Anchor for the feed's mailing nudge: /settings?focus=notify brings the mailing
  // toggle to the MIDDLE of the screen and glows it for ~1.8s, so the user sees at
  // once what he was sent here for.
  const notifyRowRef = useRef<HTMLDivElement | null>(null);
  const [notifyFocus, setNotifyFocus] = useState(false);
  useEffect(() => {
    // Mount-only ([] deps on purpose): consuming the query param below re-renders the
    // screen, and a searchParams dependency would tear this down mid-scroll.
    if (searchParams.get('focus') !== 'notify') return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    // Two frames: the router's ScrollToTop zeroes the document in a layout effect on
    // entry, so a same-frame scrollIntoView gets overwritten (desktop especially).
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        notifyRowRef.current?.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
        setNotifyFocus(true);
      });
    });
    const off = window.setTimeout(() => setNotifyFocus(false), 1800);
    // Drop ?focus=notify so a re-render / Back from a sub-screen never replays it.
    setSearchParams({}, { replace: true });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      window.clearTimeout(off);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // With a known cap it is a plain comparison; while it is unknown, any touch of
  // the chips counts (the user's explicit choice must be sendable even when it
  // equals what the screen was showing).
  const capDirty = sCap === undefined ? capTouched : cap !== sCap;

  const dirty =
    !sameSet(work, sWork) ||
    !sameSet(visa, sVisa) ||
    paid !== (sFee === 'free' || sFee === 'paid' ? sFee : null) ||
    housing !== (sHousing === true) ||
    meals !== (sMeals === true) ||
    notify !== sNotify ||
    capDirty ||
    digest !== sDigest;

  const save = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      const body = toSubscription({
        // Cities + regions + "no city" are edited on the /settings/cities
        // sub-screen; keep the saved values untouched here.
        citySlugs: sCities,
        regionSlugs: sRegions,
        noCity: sNoCity,
        workTypes: work,
        notify,
        // Sent as soon as the client knows a cap (from /me) or the user picked
        // one; null = "no limit". Left out while it is unknown and untouched, so
        // a save from this screen cannot wipe a cap the client never saw.
        notifyDailyCap: sCap !== undefined || capTouched ? cap : undefined,
        visaTypes: visa,
        placementFee: paid,
        requireHousing: housing ? true : null,
        requireMeals: meals ? true : null,
        digestEnabled: digest,
      });
      const saved = await api.saveSubscription(body);
      apply(saved);
      // The chosen cap is now stored server-side: later saves may go back to
      // omitting it (keep-on-absent), and the button can settle on "Сохранено".
      setCapTouched(false);
    } catch {
      /* keep local edits; the user can retry */
    } finally {
      setSaving(false);
    }
  }, [saving, sCities, sRegions, sNoCity, work, notify, cap, capTouched, sCap, visa, paid, housing, meals, digest, apply]);

  const citiesLabel = citiesSummary(sCities, sRegions, sNoCity, bySlug, lang, t);

  const workOptions = useMemo<ChipOption<WorkType>[]>(
    () => WORK_TYPES.map((w) => ({ value: w, label: t(workTypeKey(w)), icon: <WorkTypeIcon type={w} /> })),
    [t],
  );
  const visaOptions = useMemo<ChipOption<VisaType>[]>(
    () => VISA_TYPES.map((v) => ({ value: v, label: t(visaKey(v)) })),
    [t],
  );
  // Daily message cap: plain numbers + an explicit "no limit" chip (the title
  // above them carries the unit, so bare digits read fine and stay on one row).
  const capOptions = useMemo<ChipOption<string>[]>(
    () =>
      CAP_CHOICES.map((n) => ({
        value: capToChip(n),
        label: n === null ? t('settings.notifyCapUnlimited') : String(n),
      })),
    [t],
  );
  const paidOptions: ChipOption<'free' | 'paid'>[] = [
    { value: 'free', label: t('fee.free') },
    { value: 'paid', label: t('fee.paid') },
  ];

  return (
    <div className="app">
      <AppBar title={t('settings.title')} />
      <div className="screen">
        {shareToast != null ? (
          <div className="ref-toast" role="status">
            {shareToast}
          </div>
        ) : null}
        <div className="hero">
          <h1 className="hero__title">{t('settings.subscriptionTitle')}</h1>
          <p className="hero__sub">{t('settings.subscriptionHint')}</p>
        </div>

        <div className="region">
          <div className="section">
            <div className={`row ${notifyFocus ? 'row--focus' : ''}`} ref={notifyRowRef}>
              <div className="row__label">
                <div>{t('settings.notifications')}</div>
                <div className="row__sub">{t('settings.notificationsHint')}</div>
              </div>
              <Switch checked={notify} onChange={setNotify} label={t('settings.notifications')} />
            </div>
            {/* Child of the toggle above: how many DMs a day the bot may send.
                Stays MOUNTED and folds open/closed (grid-rows 0fr↔1fr + fade); while
                folded it is `visibility: hidden`, so its chips leave the tab order and
                aria-hidden keeps them off screen readers. Hiding beats disabling here —
                a greyed-out five-chip row under an off switch is just noise. */}
            <div className={`notifycap ${notify ? 'is-open' : ''}`} aria-hidden={!notify}>
              <div className="notifycap__inner">
                <div className="row row--stack notifycap__row">
                  <div className="row__label">{t('settings.notifyCapTitle')}</div>
                  <ChipSelect
                    single
                    options={capOptions}
                    value={[capToChip(cap)]}
                    onChange={(next) => {
                      // Radio semantics: SOME cap is always in effect (a number or
                      // "no limit"), so tapping the active chip must not clear it.
                      const picked = next[0];
                      if (picked === undefined) return;
                      setCap(picked === CAP_OFF ? null : Number(picked));
                      setCapTouched(true);
                    }}
                  />
                  <div className="row__sub row__sub--block">{t('settings.notifyCapHint')}</div>
                </div>
              </div>
            </div>
            <div className="row">
              <div className="row__label">
                <div>{t('settings.digest')}</div>
                <div className="row__sub">{t('settings.digestHint')}</div>
              </div>
              {/* INDEPENDENT of the realtime notify toggle (Цензор, gate 21.07): a user may
                  want only the once-a-day digest. The bot's ability to DM is granted by
                  allows_write_to_pm, not by the notify subscription flag. */}
              <Switch checked={digest} onChange={setDigest} label={t('settings.digest')} />
            </div>
          </div>
        </div>

        <div className="region">
          <div className="section">
            <button className="row row--nav" onClick={() => navigate('/settings/cities')}>
              <div className="row__label">
                <div>{t('settings.citiesTitle')}</div>
                <div className="row__sub row__sub--ellipsis">{citiesLabel}</div>
              </div>
              <span className="row__chevron" aria-hidden>
                ›
              </span>
            </button>
          </div>
        </div>

        <div className="region">
          <div className="region__title">{t('filter.workTypesSection')}</div>
          <ChipSelect grid options={workOptions} value={work} onChange={setWork} />
        </div>

        <div className="region">
          <div className="region__title">{t('filter.visa')}</div>
          <ChipSelect grid={2} options={visaOptions} value={visa} onChange={setVisa} />
        </div>

        <div className="region">
          <div className="region__title">{t('filter.paid')}</div>
          <ChipSelect
            single
            options={paidOptions}
            value={paid ? [paid] : []}
            onChange={(next) => setPaid((next[0] as 'free' | 'paid') ?? null)}
          />
        </div>

        <div className="region">
          <div className="section">
            <div className="row">
              <div className="row__label">{t('filter.housing')}</div>
              <Switch checked={housing} onChange={setHousing} label={t('filter.housing')} />
            </div>
            <div className="row">
              <div className="row__label">{t('filter.meals')}</div>
              <Switch checked={meals} onChange={setMeals} label={t('filter.meals')} />
            </div>
          </div>
        </div>

        <button
          className="btn btn--primary btn--block"
          onClick={save}
          disabled={!dirty || saving}
          style={{ marginBottom: 22 }}
        >
          {saving ? t('common.saving') : dirty ? t('settings.saveSubscription') : t('settings.saved')}
        </button>

        {/* Explicit, prominent app-share (owner ask: not buried inside the referral
            sub-screen). Reuses the shared app-share hook + referral.shareSent toast. */}
        <div className="region">
          <button className="share-app" onClick={() => void shareApp()}>
            <span className="share-app__icon" aria-hidden>
              <ShareIcon />
            </span>
            <span className="share-app__label">{t('settings.shareApp')}</span>
          </button>
        </div>

        <div className="region">
          <div className="section">
            <button className="row row--nav" onClick={() => setTourReplay(true)}>
              <div className="row__label">
                <div>{t('settings.howto')}</div>
                <div className="row__sub">{t('settings.howtoHint')}</div>
              </div>
              <span className="row__chevron" aria-hidden>
                ›
              </span>
            </button>
            <button className="row row--nav" onClick={() => navigate('/referral')}>
              <div className="row__label">
                <div>{t('settings.inviteFriends')}</div>
                <div className="row__sub">{t('settings.inviteFriendsHint')}</div>
              </div>
              <span className="row__chevron" aria-hidden>
                ›
              </span>
            </button>
            <button className="row row--nav" onClick={() => navigate('/safety')}>
              <div className="row__label">
                <div>{t('settings.safety')}</div>
                <div className="row__sub">{t('settings.safetyHint')}</div>
              </div>
              <span className="row__chevron" aria-hidden>
                ›
              </span>
            </button>
            <button className="row row--nav" onClick={() => navigate('/rules')}>
              <div className="row__label">
                <div>{t('settings.rules')}</div>
                <div className="row__sub">{t('settings.rulesHint')}</div>
              </div>
              <span className="row__chevron" aria-hidden>
                ›
              </span>
            </button>
            <button className="row row--nav" onClick={() => navigate('/privacy')}>
              <div className="row__label">
                <div>{t('settings.privacy')}</div>
                <div className="row__sub">{t('settings.privacyHint')}</div>
              </div>
              <span className="row__chevron" aria-hidden>
                ›
              </span>
            </button>
            {/* The one visible way to reach a human — the same @-handle every legal
                text points at. Sits under Rules/Privacy on purpose: that is where a
                reader lands with a data-removal or "who are you" question. */}
            <button className="row row--nav" onClick={() => openSupportChat(isReal)}>
              <div className="row__label">
                <div>{t('settings.contact')}</div>
                <div className="row__sub">{t('settings.contactHint', { bot: `@${SUPPORT_BOT}` })}</div>
              </div>
              <span className="row__chevron" aria-hidden>
                ›
              </span>
            </button>
          </div>
        </div>

        <div className="region">
          <div className="region__title">{t('settings.appearance')}</div>
          <div className="section">
            {/* Long schedule hint sits on its own full-width line UNDER the
                segmented control, so it never gets squeezed / mis-wrapped beside
                the three theme buttons. */}
            <div className="row row--stack">
              <div className="row__line">
                <div className="row__label">{t('settings.theme')}</div>
                <Segmented<ThemeMode>
                  value={themeMode}
                  options={[
                    { value: 'auto', label: t('settings.themeAuto') },
                    { value: 'light', label: t('settings.themeLight') },
                    { value: 'dark', label: t('settings.themeDark') },
                  ]}
                  onChange={onThemeChange}
                />
              </div>
              <div className="row__sub row__sub--block">{t('settings.themeHint')}</div>
            </div>
            <div className="row">
              <span className="row__label">{t('settings.language')}</span>
              <Segmented<Lang>
                value={lang}
                options={[
                  { value: 'ru', label: 'RU' },
                  { value: 'en', label: 'EN' },
                ]}
                onChange={setLang}
              />
            </div>
          </div>
        </div>

        <div className="region">
          <div className="region__title">{t('settings.aboutTitle')}</div>
          <div className="section">
            <div className="dl">
              <span className="dl__v">{t('settings.aboutText')}</span>
            </div>
          </div>
        </div>
      </div>

      <Modal
        open={autoInfo}
        title={t('settings.themeAutoInfo.title')}
        actions={
          <button className="btn btn--primary btn--block" onClick={() => setAutoInfo(false)}>
            {t('settings.themeAutoInfo.ok')}
          </button>
        }
      >
        <p className="modal__text">{t('settings.themeAutoInfo.body')}</p>
      </Modal>
    </div>
  );
}
