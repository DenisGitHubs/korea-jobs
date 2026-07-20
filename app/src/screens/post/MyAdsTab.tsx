import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../../shared/api/client';
import type { AdMine } from '../../shared/types/api';
import { useSettingsStore } from '../../store/settingsStore';
import { localized } from '../../lib/localized';
import { adStatusInfo } from '../../lib/adStatus';
import { workTypeKey } from '../../shared/labels';
import { WorkTypeIcon } from '../../components/icons/WorkTypeIcon';
import { EmptyState } from '../../components/EmptyState';
import { Modal } from '../../components/Modal';

/** Reject reasons we have friendly copy for; anything else is shown verbatim. */
const KNOWN_REASONS = new Set(['too_short', 'no_contact', 'policy', 'network']);

interface MyAdsTabProps {
  /** Prefill the compose wizard with this ad and switch to edit mode. */
  onEdit: (ad: AdMine) => void;
  /** Jump to the "Post" tab (used by the empty state CTA). */
  onGoCompose: () => void;
}

/**
 * "My ads" tab: the author's own listings with per-ad status chips and actions
 * (bump / edit / archive-or-delete / unarchive). All requests go through the
 * api client, so this works identically against the mock and the real backend.
 */
export function MyAdsTab({ onEdit, onGoCompose }: MyAdsTabProps) {
  const { t } = useTranslation();
  const lang = useSettingsStore((s) => s.lang);

  const [ads, setAds] = useState<AdMine[] | null>(null);
  const [error, setError] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<AdMine | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    setError(false);
    setAds(null);
    api
      .adsMine()
      .then(setAds)
      .catch(() => setError(true));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Transient toast (auto-dismiss). Timer is cleared on unmount / re-toast.
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  const patchAd = useCallback((id: string, next: Partial<AdMine>) => {
    setAds((prev) => (prev ? prev.map((a) => (a.id === id ? { ...a, ...next } : a)) : prev));
  }, []);

  const onBump = useCallback(
    (ad: AdMine) => {
      setBusyId(ad.id);
      api
        .adBump(ad.id)
        .then((r) => {
          patchAd(ad.id, { bumped_at: r.bumped_at });
          showToast(t('myAds.toast.bumped'));
        })
        .catch((e) => {
          if (e instanceof ApiError && e.http === 429) showToast(t('myAds.toast.bumpCooldown'));
          else showToast(t('myAds.toast.error'));
        })
        .finally(() => setBusyId(null));
    },
    [patchAd, showToast, t],
  );

  const onArchive = useCallback(
    (ad: AdMine) => {
      setBusyId(ad.id);
      setConfirm(null);
      api
        .adArchive(ad.id)
        .then(() => {
          patchAd(ad.id, { status: 'archived' });
          showToast(t('myAds.toast.archived'));
        })
        .catch(() => showToast(t('myAds.toast.error')))
        .finally(() => setBusyId(null));
    },
    [patchAd, showToast, t],
  );

  const onUnarchive = useCallback(
    (ad: AdMine) => {
      setBusyId(ad.id);
      api
        .adUnarchive(ad.id)
        .then((r) => {
          patchAd(ad.id, { status: r.status, reject_reason: r.status === 'rejected' ? ad.reject_reason : null });
          showToast(
            r.status === 'approved'
              ? t('myAds.toast.unarchivedApproved')
              : r.status === 'pending'
                ? t('myAds.toast.unarchivedPending')
                : t('myAds.toast.unarchivedRejected'),
          );
        })
        .catch(() => showToast(t('myAds.toast.error')))
        .finally(() => setBusyId(null));
    },
    [patchAd, showToast, t],
  );

  const onDelete = useCallback(
    (ad: AdMine) => {
      setBusyId(ad.id);
      setConfirm(null);
      api
        .adDelete(ad.id)
        .then(() => {
          setAds((prev) => (prev ? prev.filter((a) => a.id !== ad.id) : prev));
          showToast(t('myAds.toast.deleted'));
        })
        .catch(() => showToast(t('myAds.toast.error')))
        .finally(() => setBusyId(null));
    },
    [showToast, t],
  );

  if (error) {
    return (
      <EmptyState
        emoji="⚠️"
        title={t('common.error')}
        subtitle={t('myAds.loadError')}
        actionLabel={t('common.retry')}
        onAction={load}
      />
    );
  }

  if (ads === null) {
    return (
      <div className="stack" aria-busy="true" aria-label={t('common.loading')}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="skeleton-card">
            <div className="skeleton-line skeleton-line--lg" />
            <div className="skeleton-line skeleton-line--sm" />
            <div className="skeleton-line" />
          </div>
        ))}
      </div>
    );
  }

  if (ads.length === 0) {
    return (
      <EmptyState
        emoji="📝"
        title={t('myAds.emptyTitle')}
        subtitle={t('myAds.emptySub')}
        actionLabel={t('myAds.emptyCta')}
        onAction={onGoCompose}
      />
    );
  }

  const now = Date.now();
  return (
    <>
      <div className="stack">
        {ads.map((ad) => {
          const info = adStatusInfo(ad.status, ad.created_at, ad.bumped_at, now, t);
          const cityName = ad.city ? localized(ad.city.name, lang) : null;
          const busy = busyId === ad.id;
          const canBump = ad.status === 'approved';
          const canUnarchive = ad.status === 'archived';
          const canEdit = ad.status !== 'taken_down';
          const reason =
            ad.status === 'rejected' && ad.reject_reason
              ? KNOWN_REASONS.has(ad.reject_reason)
                ? t(`post.reject.${ad.reject_reason}`)
                : ad.reject_reason
              : null;

          return (
            <div key={ad.id} className="ad-card">
              <div className="ad-card__head">
                <div className="ad-card__title">{ad.title}</div>
                <span className={`ad-status ad-status--${info.kind}`}>{info.label}</span>
              </div>
              <div className="ad-card__meta">
                <WorkTypeIcon type={ad.work_type} />
                <span>{t(workTypeKey(ad.work_type))}</span>
                {cityName ? <span className="ad-card__dot">·</span> : null}
                {cityName ? <span>{cityName}</span> : null}
              </div>
              {reason ? <div className="ad-card__reason">{reason}</div> : null}

              <div className="ad-actions">
                {canBump ? (
                  <button className="btn btn--secondary btn--sm" onClick={() => onBump(ad)} disabled={busy}>
                    {t('myAds.action.bump')}
                  </button>
                ) : null}
                {canUnarchive ? (
                  <button className="btn btn--secondary btn--sm" onClick={() => onUnarchive(ad)} disabled={busy}>
                    {t('myAds.action.unarchive')}
                  </button>
                ) : null}
                {canEdit ? (
                  <button className="btn btn--secondary btn--sm" onClick={() => onEdit(ad)} disabled={busy}>
                    {t('myAds.action.edit')}
                  </button>
                ) : null}
                <button
                  className="btn btn--ghost btn--sm ad-actions__del"
                  onClick={() => setConfirm(ad)}
                  disabled={busy}
                >
                  {t('myAds.action.delete')}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <Modal
        open={confirm !== null}
        title={t('myAds.delete.title')}
        actions={
          confirm ? (
            <>
              {confirm.status !== 'archived' && confirm.status !== 'taken_down' ? (
                <button
                  className="btn btn--secondary btn--block"
                  onClick={() => onArchive(confirm)}
                  disabled={busyId === confirm.id}
                >
                  {t('myAds.delete.archive')}
                </button>
              ) : null}
              <button
                className="btn btn--danger btn--block"
                onClick={() => onDelete(confirm)}
                disabled={busyId === confirm.id}
              >
                {t('myAds.delete.forever')}
              </button>
              <button className="btn btn--ghost btn--block" onClick={() => setConfirm(null)}>
                {t('myAds.delete.cancel')}
              </button>
            </>
          ) : null
        }
      >
        <p className="modal__text">
          {confirm && confirm.status !== 'archived' && confirm.status !== 'taken_down'
            ? t('myAds.delete.body')
            : t('myAds.delete.bodyArchived')}
        </p>
        <p className="modal__text modal__text--warn">{t('myAds.delete.foreverNote')}</p>
      </Modal>

      {toast ? (
        <div className="kj-toast" role="status">
          {toast}
        </div>
      ) : null}
    </>
  );
}
