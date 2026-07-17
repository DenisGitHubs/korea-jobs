import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useBackButton } from '../hooks/useBackButton';
import { AppBar } from '../components/AppBar';

const FLAGS = ['prepay', 'tooGoodSalary', 'moveMoney', 'giveDocuments', 'noCompany', 'blankContract'] as const;
const RULES = ['employerPays', 'keepDocuments', 'getContract', 'checkBeforePay', 'dontAcceptMoney', 'reportSafely'] as const;
const HELP: Array<{ k: string; tel: string }> = [
  { k: 'immigration', tel: '1345' },
  { k: 'labor', tel: '1350' },
  { k: 'eps', tel: '1577-0071' },
  { k: 'legal', tel: '132' },
  { k: 'finFraud', tel: '1332' },
  { k: 'police', tel: '112' },
];

function BadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

function GoodIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2 4.2 2 2 0 0 1 4 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.6a2 2 0 0 1-.5 2.1L8 9.6a16 16 0 0 0 6 6l1.2-1.1a2 2 0 0 1 2.1-.5c.8.3 1.7.5 2.6.6a2 2 0 0 1 1.7 2Z" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

export default function SafetyScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const goBack = useCallback(() => navigate(-1), [navigate]);
  useBackButton(true, goBack);

  return (
    <div className="app">
      <AppBar title={t('safety.title')} onBack={goBack} />
      <div className="screen">
        <div className="safehero">
          <p className="hero__sub">{t('safety.lead')}</p>
        </div>

        <div className="trust" style={{ marginBottom: 16 }}>
          <span className="trust__ico">
            <ShieldIcon />
          </span>
          <div>
            <div className="trust__t">{t('safety.trustCard.title')}</div>
            <div className="trust__s">{t('safety.trustCard.body')}</div>
          </div>
        </div>

        <div className="region">
          <div className="region__title">{t('safety.flagsTitle')}</div>
          <div className="section">
            {FLAGS.map((k) => (
              <div className="safe-row" key={k}>
                <span className="safe-row__ico safe-row__ico--bad">
                  <BadIcon />
                </span>
                <div>
                  <div className="safe-row__t">{t(`safety.flags.${k}.title`)}</div>
                  <div className="safe-row__s">{t(`safety.flags.${k}.body`)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="region">
          <div className="region__title">{t('safety.rulesTitle')}</div>
          <div className="section">
            {RULES.map((k) => (
              <div className="safe-row" key={k}>
                <span className="safe-row__ico safe-row__ico--good">
                  <GoodIcon />
                </span>
                <div>
                  <div className="safe-row__t">{t(`safety.rules.${k}.title`)}</div>
                  <div className="safe-row__s">{t(`safety.rules.${k}.body`)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="region">
          <div className="region__title">{t('safety.helpTitle')}</div>
          <p className="hint">{t('safety.helpLead')}</p>
          <div className="section">
            {HELP.map(({ k, tel }) => (
              <a className="safe-row" key={k} href={`tel:${tel.replace(/[^0-9+]/g, '')}`}>
                <span className="safe-row__ico safe-row__ico--call">
                  <PhoneIcon />
                </span>
                <div>
                  <div className="safe-row__t">
                    <span className="safe-row__tel">{tel}</span> · {t(`safety.help.${k}.title`)}
                  </div>
                  <div className="safe-row__s">{t(`safety.help.${k}.body`)}</div>
                </div>
              </a>
            ))}
          </div>
          <p className="hint">{t('safety.help.note')}</p>
        </div>

        <p className="ref-disclaimer">{t('safety.disclaimer')}</p>
      </div>
    </div>
  );
}
