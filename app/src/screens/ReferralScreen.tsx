import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../shared/api/client';
import type { ReferralView, StreakStat } from '../shared/types/api';
import { useBackButton } from '../hooks/useBackButton';
import { useShareApp } from '../hooks/useShareApp';
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
/** Last tier index the user has seen — drives the festive "tier up" celebration. */
const TIER_SEEN_KEY = 'kj:refTierSeen';

type Tier = (typeof STATUS_TIERS)[number];

/** Highest tier index reached for a given number of confirmed direct invites. */
function tierIndexFor(directInvited: number): number {
  let idx = 0;
  for (let i = 0; i < STATUS_TIERS.length; i++) {
    if (directInvited >= STATUS_TIERS[i].min) idx = i;
  }
  return idx;
}

interface TierProgress {
  tier: Tier;
  nextTier: Tier | undefined;
  toNext: number;
  /** Fill % of the bar toward the next tier: clamp((got - min)/(nextMin - min)*100, 0, 100). */
  pct: number;
}

function tierProgress(directInvited: number): TierProgress {
  const idx = tierIndexFor(directInvited);
  const tier = STATUS_TIERS[idx];
  const nextTier = STATUS_TIERS[idx + 1];
  const toNext = nextTier ? nextTier.min - directInvited : 0;
  const pct = nextTier
    ? Math.max(0, Math.min(100, ((directInvited - tier.min) / (nextTier.min - tier.min)) * 100))
    : 0;
  return { tier, nextTier, toNext, pct };
}

/** Compact progress bar: [current badge] [filled track] [next badge]. Render only when nextTier exists. */
function RefProgress({ tier, nextTier, pct }: { tier: Tier; nextTier: Tier; pct: number }) {
  return (
    <div className="ref-progress">
      <div className="ref-progress__row">
        <span className="ref-progress__cap ref-progress__cap--current" aria-hidden>
          {tier.emoji || '•'}
        </span>
        <span className="ref-progress__track">
          <span className="ref-progress__fill" style={{ width: `${pct}%` }} />
        </span>
        <span className="ref-progress__cap" aria-hidden>
          {nextTier.emoji}
        </span>
      </div>
    </div>
  );
}

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

/** Transient celebration shown on load when the confirmed balance grew. */
type Celebrate = { tierUp: boolean; gain: number; directInvited: number };

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
  // App-invite share (rich card + link fallback) + its "Sent" banner, shared with
  // the Settings "Share the app" button — no duplicated fallback logic.
  const { shareApp, shareToast } = useShareApp();

  const [state, setState] = useState<State>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [copied, setCopied] = useState(false);
  // Transient celebration card shown when the confirmed balance grew since the last
  // visit (festive tier-up variant, or an ordinary "+N points" variant). Null = hidden.
  const [celebrate, setCelebrate] = useState<Celebrate | null>(null);

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

  // Announce newly *confirmed* progress since the last visit, so confirmation is no
  // longer silent. We compare BOTH points_total and the tier index against baselines:
  //   • points grew + tier index grew → festive "new badge" celebration
  //   • points grew, same tier        → ordinary "+N points" celebration
  //   • first-ever visit              → only record baselines (no card)
  useEffect(() => {
    if (state.status !== 'ready') return;
    const total = state.data.points_total;
    const directInvited = state.data.levels[0]?.invited ?? 0;
    const idx = tierIndexFor(directInvited);
    try {
      const rawPts = localStorage.getItem(POINTS_SEEN_KEY);
      const seenPts = rawPts == null ? null : Number.parseInt(rawPts, 10);
      const rawTier = localStorage.getItem(TIER_SEEN_KEY);
      const seenTier = rawTier == null ? null : Number.parseInt(rawTier, 10);
      if (seenPts != null && Number.isFinite(seenPts) && total > seenPts) {
        const tierUp = seenTier != null && Number.isFinite(seenTier) && idx > seenTier;
        setCelebrate({ tierUp, gain: total - seenPts, directInvited });
      }
      localStorage.setItem(POINTS_SEEN_KEY, String(total));
      localStorage.setItem(TIER_SEEN_KEY, String(idx));
    } catch {
      /* storage blocked — skip the celebration */
    }
  }, [state]);

  // The ordinary (points-only) celebration auto-dismisses after 6s; the festive
  // tier-up one stays until the user closes it (✕).
  useEffect(() => {
    if (celebrate == null || celebrate.tierUp) return;
    const id = window.setTimeout(() => setCelebrate(null), 6000);
    return () => window.clearTimeout(id);
  }, [celebrate]);

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

  return (
    <div className="app">
      <AppBar title={t('referral.title')} onBack={goBack} />
      <div className="screen">
        {celebrate != null
          ? (() => {
              const { tier, nextTier, toNext, pct } = tierProgress(celebrate.directInvited);
              // Festive variant → the NEW tier's emoji; ordinary variant → the current
              // tier's emoji (or a generic 🎉 for the badge-less novice tier).
              const badgeEmoji = tier.emoji || '🎉';
              return (
                <div className="ref-celebrate" role="status">
                  <button
                    className="ref-celebrate__close"
                    onClick={() => setCelebrate(null)}
                    aria-label={t('common.close')}
                  >
                    ✕
                  </button>
                  <span className="ref-celebrate__badge" aria-hidden>
                    {badgeEmoji}
                  </span>
                  {celebrate.tierUp ? (
                    <>
                      <div className="ref-celebrate__title">
                        {t('referral.tierUp.title', {
                          emoji: tier.emoji,
                          name: t(`referral.status.${tier.key}`),
                        })}
                      </div>
                      <div className="ref-celebrate__sub">
                        {t('referral.tierUp.sub', { count: celebrate.directInvited })}
                      </div>
                      {nextTier ? (
                        <RefProgress tier={tier} nextTier={nextTier} pct={pct} />
                      ) : (
                        <div className="ref-celebrate__sub">{t('referral.status.max')}</div>
                      )}
                    </>
                  ) : (
                    <>
                      <div className="ref-celebrate__title">
                        {t('referral.pointsGained', { count: celebrate.gain })}
                      </div>
                      {nextTier ? (
                        <>
                          <RefProgress tier={tier} nextTier={nextTier} pct={pct} />
                          <div className="ref-celebrate__sub">
                            {t('referral.status.next', { count: toNext })}
                          </div>
                        </>
                      ) : (
                        <div className="ref-celebrate__sub">{t('referral.status.max')}</div>
                      )}
                    </>
                  )}
                </div>
              );
            })()
          : null}
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
          <ReferralBody data={state.data} copied={copied} onCopy={copy} onShare={shareApp} t={t} />
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
  const { tier, nextTier, toNext, pct } = tierProgress(directInvited);

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
        {/* Permanent progress bar toward the next badge (hidden at the top tier). */}
        {nextTier ? <RefProgress tier={tier} nextTier={nextTier} pct={pct} /> : null}
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
