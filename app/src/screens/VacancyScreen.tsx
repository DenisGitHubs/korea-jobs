import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../shared/api/client';
import type { VacancyContact, VacancyView } from '../shared/types/api';
import { feeKey, genderKey, visaKey } from '../shared/labels';
import { useBackButton } from '../hooks/useBackButton';
import { useSettingsStore } from '../store/settingsStore';
import { localized } from '../lib/localized';
import { salaryLine, timeAgo } from '../lib/format';
import { AppBar } from '../components/AppBar';
import { Loading } from '../components/Loading';
import { EmptyState } from '../components/EmptyState';
import { WorkTypeBadge } from '../components/WorkTypeBadge';

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

export default function VacancyScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { id = '' } = useParams();
  const lang = useSettingsStore((s) => s.lang);

  const [vacancy, setVacancy] = useState<VacancyView | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [contact, setContact] = useState<ContactState>({ status: 'idle' });
  const [copied, setCopied] = useState(false);
  const [reported, setReported] = useState(false);

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

  const threeState = (v: boolean | null): string =>
    v === true ? t('common.yes') : v === false ? t('common.no') : t('vacancy.notStated');

  const isRepost = Boolean((vacancy as { repost?: boolean } | null)?.repost);

  return (
    <div className="app">
      <AppBar title={t('vacancy.title')} onBack={goBack} />
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
              <p className="hero__note">{t('vacancy.mayBeTaken')}</p>
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
              <div className="dl">
                <span className="dl__k">{t('vacancy.salary')}</span>
                <span className="dl__v">{salaryLine(vacancy, t) ?? t('vacancy.salaryNA')}</span>
              </div>
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

            {/* Contact is revealed only on explicit action (anti-harvesting). */}
            {!vacancy.has_contact ? (
              <div className="muted" style={{ padding: '4px 4px' }}>
                {t('vacancy.noContact')}
              </div>
            ) : contact.status === 'idle' ? (
              <button className="btn btn--primary btn--block" onClick={revealContact}>
                {t('vacancy.showContact')}
              </button>
            ) : contact.status === 'loading' ? (
              <Loading text={t('vacancy.loadingContact')} />
            ) : contact.contact ? (
              <div className="contact">
                <div>
                  <div className="contact__kind">{t(`contactKind.${contact.contact.kind}`)}</div>
                  <div className="contact__value">{contact.contact.value}</div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn--secondary" onClick={() => copy(contact.contact!.value)}>
                    {copied ? t('vacancy.copied') : t('vacancy.copy')}
                  </button>
                  {contactHref(contact.contact) ? (
                    <a
                      className="btn btn--primary"
                      href={contactHref(contact.contact) ?? undefined}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t('vacancy.open')}
                    </a>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="muted" style={{ padding: '4px 4px' }}>
                {t('vacancy.noContact')}
              </div>
            )}

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
