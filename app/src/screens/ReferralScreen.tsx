import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { postEvent, shareMessage } from '@telegram-apps/sdk-react';
import { api } from '../shared/api/client';
import type { ReferralView, StreakStat } from '../shared/types/api';
import { useBackButton } from '../hooks/useBackButton';
import { useSettingsStore } from '../store/settingsStore';
import { AppBar } from '../components/AppBar';
import { Loading } from '../components/Loading';
import { EmptyState } from '../components/EmptyState';
import { IconWarn } from '../components/icons/StateIcons';

/** Teaser bullets — all future ("planned"); nothing is spendable yet. */
const REWARDS = ['faster', 'boost', 'status', 'discounts'] as const;
const REWARD_ICON: Record<(typeof REWARDS)[number], string> = {
  faster: '⚡',
  boost: '🚀',
  status: '⭐',
  discounts: '🎫',
};

/**
 * Frontend-computed status from confirmed *direct* invites (levels[0].invited).
 * Thresholds are provisional constants (owner: give a non-monetary reward now so
 * points don't feel like "saving into a void"); names to be finalised by Katya.
 */
const STATUS_TIERS = [
  { min: 0, emoji: '', key: 'novice' },
  { min: 1, emoji: '🥉', key: 'guide' },
  { min: 10, emoji: '🥈', key: 'mentor' },
  { min: 25, emoji: '🥇', key: 'master' },
] as const;

/** Last points_total the user has seen — drives the "+N points" nudge. */
const POINTS_SEEN_KEY = 'kj:refPointsSeen';

type TFn = ReturnType<typeof useTranslation>['t'];

/**
 * Days-to-next-bonus caption. Bonus size + cadence come from the API (server-driven).
 * On an exact multiple (a bonus was just earned) we say so and count down the next cycle;
 * otherwise we show how many days are left. len === 0 → a full cycle remains.
 */
function streakHint(s: StreakStat, t: TFn): string {
  const every = s.bonus_every > 0 ? s.bonus_every : 7;
  const rem = s.len % every;
  if (s.len > 0 && rem === 0) {
    return t('referral.streakBonusGot', { count: every });
  }
  return t('referral.streakToBonus', { count: every - rem, bonus: s.bonus });
}

type State =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; data: ReferralView };

function ShareIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
    </svg>
  );
}

export default function ReferralScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isReal = useSettingsStore((s) => s.isReal);

  const [state, setState] = useState<State>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [copied, setCopied] = useState(false);
  const [gain, setGain] = useState<number | null>(null);
  // Transient banner for the app-share success ("Sent"). Null = hidden.
  const [shareToast, setShareToast] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    api
      .referral()
      .then((d) => {
        if (alive) setState({ status: 'ready', data: d });
      })
      .catch(() => {
        if (alive) setState({ status: 'error' });
      });
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  // Announce newly *confirmed* points since the last visit, so confirmation is
  // no longer silent. First-ever visit only records a baseline (no nudge).
  useEffect(() => {
    if (state.status !== 'ready') return;
    const total = state.data.points_total;
    try {
      const raw = localStorage.getItem(POINTS_SEEN_KEY);
      const seen = raw == null ? null : Number.parseInt(raw, 10);
      if (seen != null && Number.isFinite(seen) && total > seen) {
        setGain(total - seen);
      }
      localStorage.setItem(POINTS_SEEN_KEY, String(total));
    } catch {
      /* storage blocked — skip the nudge */
    }
  }, [state]);

  useEffect(() => {
    if (gain == null) return;
    const id = window.setTimeout(() => setGain(null), 4000);
    return () => window.clearTimeout(id);
  }, [gain]);

  // Auto-dismiss the app-share toast.
  useEffect(() => {
    if (shareToast == null) return;
    const id = window.setTimeout(() => setShareToast(null), 2200);
    return () => window.clearTimeout(id);
  }, [shareToast]);

  const goBack = useCallback(() => navigate(-1), [navigate]);
  useBackButton(true, goBack);

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

  // The CURRENT app-invite share path — kept intact as the graceful fallback below.
  // Opens Telegram's native "share to a chat" sheet; the link travels ONLY in the
  // `url` param (so it never duplicates inside the text), `text` is the pitch.
  const shareFallback = useCallback(
    (link: string) => {
      const pathFull = `/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(
        t('referral.shareText'),
      )}`;
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
    [isReal, t],
  );

  // Share the APP itself. Preferred path (Bot API 8.0+): the backend mints a
  // "prepared inline message" (rich invite card) handed to Telegram's native share
  // sheet via WebApp.shareMessage. DEGRADES SILENTLY to the current link-share
  // (`shareFallback`) on every failure mode, so nothing regresses on older clients:
  //   • shareMessage.isAvailable() === false → client < 8.0 / unsupported / no SDK env
  //     (the endpoint is never even called), or
  //   • the backend opts out ({ fallback:true }) or returns no preparedMessageId, or
  //   • the endpoint errors / the network fails, or
  //   • the native share dialog rejects (shareMessage promise throws).
  // The referral binding rides inside the prepared card server-side; the fallback
  // link still carries the ref code as before.
  const share = useCallback(
    async (link: string) => {
      if (shareMessage.isAvailable()) {
        try {
          const prep = await api.sharePrepare({ kind: 'app' });
          if (prep.ok && !prep.fallback && prep.preparedMessageId) {
            // Resolves on `prepared_message_sent`, rejects on `prepared_message_failed`
            // (or a dismissed dialog) → the catch below falls back.
            await shareMessage(prep.preparedMessageId);
            setShareToast(t('referral.shareSent'));
            return;
          }
        } catch {
          /* backend/network/dialog failure → fall through to the link-share */
        }
      }
      shareFallback(link);
    },
    [shareFallback, t],
  );

  return (
    <div className="app">
      <AppBar title={t('referral.title')} onBack={goBack} />
      <div className="screen">
        {gain != null ? (
          <div className="ref-toast" role="status">
            {t('referral.pointsGained', { count: gain })}
          </div>
        ) : null}
        {shareToast != null ? (
          <div className="ref-toast" role="status">
            {shareToast}
          </div>
        ) : null}

        {state.status === 'loading' ? (
          <Loading text={t('common.loading')} />
        ) : state.status === 'error' ? (
          <EmptyState
            icon={<IconWarn />}
            title={t('referral.loadError')}
            actionLabel={t('common.retry')}
            onAction={() => setReloadKey((k) => k + 1)}
          />
        ) : (
          <ReferralBody data={state.data} copied={copied} onCopy={copy} onShare={share} t={t} />
        )}
      </div>
    </div>
  );
}

function ReferralBody({
  data,
  copied,
  onCopy,
  onShare,
  t,
}: {
  data: ReferralView;
  copied: boolean;
  onCopy: (v: string) => void;
  onShare: (link: string) => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const { link, points_total, points_pending, levels, streaks } = data;
  const totalInvited = levels.reduce((sum, l) => sum + l.invited, 0);

  // Visit gets the 🔥; open is the quieter companion. Amounts/cadence stay server-driven.
  const streakRows = [
    { key: 'visit', s: streaks.visit, label: t('referral.streakVisit'), fire: true },
    { key: 'open', s: streaks.open, label: t('referral.streakOpen'), fire: false },
  ] as const;

  // Status from confirmed direct invites (the most legible "people you brought").
  const directInvited = levels[0]?.invited ?? 0;
  let tierIdx = 0;
  for (let i = 0; i < STATUS_TIERS.length; i++) {
    if (directInvited >= STATUS_TIERS[i].min) tierIdx = i;
  }
  const tier = STATUS_TIERS[tierIdx];
  const nextTier = STATUS_TIERS[tierIdx + 1];
  const toNext = nextTier ? nextTier.min - directInvited : 0;

  return (
    <>
      {/* Balance + status badge + confirmation-delay explanation. */}
      <section className="ref-balance">
        <div className="ref-status">
          {tier.emoji ? (
            <span className="ref-status__badge" aria-hidden>
              {tier.emoji}
            </span>
          ) : null}
          <span className="ref-status__name">{t(`referral.status.${tier.key}`)}</span>
        </div>
        <div className="ref-balance__label">{t('referral.balanceLabel')}</div>
        <div className="ref-balance__num">
          {points_total}
          <span className="ref-balance__unit">{t('referral.pointsUnit')}</span>
        </div>
        <div className="ref-status__next">
          {nextTier ? t('referral.status.next', { count: toNext }) : t('referral.status.max')}
        </div>
        {points_pending > 0 ? (
          <>
            <div className="ref-balance__pending">{t('referral.pending', { count: points_pending })}</div>
            <div className="ref-balance__pending-note">{t('referral.pendingHint')}</div>
          </>
        ) : null}
      </section>

      {/* Daily streaks — sits right under the balance (streaks feed the same points). */}
      <div className="region">
        <div className="region__title">{t('referral.streaksTitle')}</div>
        <div className="section">
          {streakRows.map(({ key, s, label, fire }) => (
            <div className="ref-streak" key={key}>
              <div className="ref-streak__top">
                <span className="ref-streak__name">
                  {label}
                  {fire ? (
                    <span className="ref-streak__fire" aria-hidden>
                      {' '}
                      🔥
                    </span>
                  ) : null}
                </span>
                <span className="ref-streak__count">
                  <b>{s.len}</b> {t('referral.streakDaysUnit', { count: s.len })}
                </span>
              </div>
              <p className="ref-streak__hint">{streakHint(s, t)}</p>
            </div>
          ))}
        </div>
      </div>

      {/* 2nd — my link, primary Share, secondary Copy link. */}
      <div className="region">
        <div className="region__title">{t('referral.myLink')}</div>
        <div className="ref-link">
          <span className="ref-link__url">{link}</span>
        </div>
        <button className="btn btn--primary btn--block ref-share" onClick={() => onShare(link)}>
          <ShareIcon />
          {t('referral.share')}
        </button>
        <button className="ref-copy" onClick={() => onCopy(link)}>
          {copied ? t('referral.copied') : t('referral.copy')}
        </button>
      </div>

      {/* Rewards teaser (planned, no dates). */}
      <div className="region">
        <div className="region__title">{t('referral.rewardsSoonTitle')}</div>
        <div className="section">
          {REWARDS.map((k) => (
            <div className="ref-reward" key={k}>
              <span className="ref-reward__icon" aria-hidden>
                {REWARD_ICON[k]}
              </span>
              <span className="ref-reward__text">{t(`referral.reward.${k}`)}</span>
              <span className="badge ref-soon">{t('referral.soonBadge')}</span>
            </div>
          ))}
        </div>
        <p className="hint">{t('referral.rewardsSoonNote')}</p>
      </div>

      {/* How it works — explanation before the numbers. */}
      <div className="region">
        <div className="region__title">{t('referral.howTitle')}</div>
        <div className="section">
          <div className="ref-how">
            <span className="ref-how__n">1</span>
            <span>{t('referral.how1')}</span>
          </div>
          <div className="ref-how">
            <span className="ref-how__n">2</span>
            <span>{t('referral.how2')}</span>
          </div>
          <div className="ref-how">
            <span className="ref-how__n">3</span>
            <span>{t('referral.how3')}</span>
          </div>
        </div>
        <p className="hint">{t('referral.howSummary')}</p>
      </div>

      {/* Prominent "not a pyramid" reassurance right by the tier numbers. */}
      <p className="ref-reassure">{t('referral.notPyramid')}</p>

      {/* Per-tier stats, or an encouraging empty state when nobody joined yet. */}
      <div className="region">
        <div className="region__title">{t('referral.statsTitle')}</div>
        <div className="section">
          {totalInvited === 0 ? (
            <div className="ref-empty">
              <div className="ref-empty__emoji" aria-hidden>
                🤝
              </div>
              <div className="ref-empty__title">{t('referral.emptyTitle')}</div>
              <div className="ref-empty__hint">{t('referral.emptyHint')}</div>
            </div>
          ) : (
            levels.map((l) => (
              <div className="ref-level" key={l.level}>
                <span className="ref-level__name">{t(`referral.level${l.level}`)}</span>
                <span className="ref-level__stats">
                  <span className="ref-level__stat">
                    <b>{l.invited}</b> {t('referral.invited')}
                  </span>
                  <span className="ref-level__stat ref-level__stat--pts">
                    <b>{l.points}</b> {t('referral.points')}
                  </span>
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      <p className="ref-disclaimer">{t('referral.disclaimer')}</p>
    </>
  );
}
