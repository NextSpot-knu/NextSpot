'use client';

import Link from 'next/link';
import { ArrowRight, Clock, MapPin, Route } from 'lucide-react';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { useT } from '@/lib/i18n/I18nProvider';
import styles from './guide.module.css';

const problemItems = [
  { key: 'problemWait', icon: Clock },
  { key: 'problemRoute', icon: Route },
  { key: 'problemMiss', icon: MapPin },
] as const;

const solutionItems = [
  { key: 'solutionTiming', icon: Clock },
  { key: 'solutionAlternative', icon: MapPin },
  { key: 'solutionRoute', icon: Route },
] as const;

export default function GuideContent({ onNavigate }: { onNavigate?: () => void }) {
  const t = useT();

  return (
    <div className={styles.guide}>
      <div className={styles.topline}>
        <span>{t('guide.hint')}</span>
        <LanguageSwitcher />
      </div>

      <section className={styles.hero}>
        <div className={styles.heroLayout}>
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>{t('guide.eyebrow')}</p>
            <h1 className={styles.heroTitle}>{t('guide.heroTitle')}</h1>
            <p className={styles.heroBody}>{t('guide.heroBody')}</p>
            <Link href="/setup" prefetch={false} onClick={onNavigate} className={styles.primary}>
              {t('guide.explore')}<ArrowRight size={18} aria-hidden />
            </Link>
          </div>

          <div className={styles.answer} role="group" aria-label={t('guide.answerLabel')}>
            <section className={styles.problemCard} aria-labelledby="nextspot-problem">
              <p>{t('guide.problemLabel')}</p>
              <h2 id="nextspot-problem">{t('guide.problemTitle')}</h2>
              <ul>
                {problemItems.map(({ key, icon: Icon }) => (
                  <li key={key}><Icon size={20} aria-hidden /><span>{t(`guide.${key}`)}</span></li>
                ))}
              </ul>
            </section>

            <div className={styles.turn} aria-hidden>
              <span>NextSpot</span><ArrowRight size={22} />
            </div>

            <section className={styles.solutionCard} aria-labelledby="nextspot-solution">
              <p>{t('guide.solutionLabel')}</p>
              <h2 id="nextspot-solution">{t('guide.solutionTitle')}</h2>
              <ul>
                {solutionItems.map(({ key, icon: Icon }) => (
                  <li key={key}><Icon size={20} aria-hidden /><span>{t(`guide.${key}`)}</span></li>
                ))}
              </ul>
            </section>

            <strong className={styles.result}>{t('guide.resultLine')}</strong>
          </div>
        </div>
      </section>
    </div>
  );
}
