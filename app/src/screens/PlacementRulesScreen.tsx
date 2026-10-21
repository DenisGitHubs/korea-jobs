import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useBackButton } from '../hooks/useBackButton';
import { useDocViewport } from '../hooks/useDocViewport';
import { AppBar } from '../components/AppBar';
import { LegalDoc } from '../components/LegalDoc';
import { PLACEMENT_RULES } from '../content/legal/placement-rules';
import type { Lang } from '../i18n';

/**
 * «Правила размещения» — same shape as PrivacyScreen / RulesScreen, so the three
 * published documents open, scroll and go back identically.
 */
export default function PlacementRulesScreen() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const goBack = useCallback(() => navigate(-1), [navigate]);
  useBackButton(true, goBack);
  useDocViewport();

  const lang: Lang = i18n.language.startsWith('en') ? 'en' : 'ru';

  return (
    <div className="app">
      <AppBar title={t('placementRules.title')} onBack={goBack} />
      <div className="screen">
        <LegalDoc doc={PLACEMENT_RULES[lang]} />
      </div>
    </div>
  );
}
