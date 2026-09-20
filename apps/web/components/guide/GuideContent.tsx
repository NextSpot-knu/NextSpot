'use client';

import { useId, useRef, type ReactNode } from 'react';
import Link from 'next/link';
import { Accessibility, ArrowDown, ArrowRight, Bookmark, Building2, Check, Coffee, Compass, Database, Footprints, Globe, Heart, Home, MapPin, Mic, Quote, Radar, Route, ShieldCheck, Sparkles, Store, Ticket, Timer, User, Waypoints } from 'lucide-react';
import { SPOT_WEIGHTS } from 'shared-types';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { useT } from '@/lib/i18n/I18nProvider';
import styles from './guide.module.css';

const chapters = [
  ['story', 'navStory'], ['score', 'navScore'], ['data', 'navData'],
  ['journey', 'navJourney'], ['impact', 'navImpact'], ['features', 'navFeatures'],
] as const;

export default function GuideContent({ onNavigate }: { onNavigate?: () => void }) {
  const t = useT();
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const jump = (chapter: string) => {
    const section = rootRef.current?.querySelector<HTMLElement>(`[data-chapter="${chapter}"]`);
    section?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
    section?.focus({ preventScroll: true });
  };
  const cta = (href: string, label: string, primary = false) => (
    <Link href={href} prefetch={false} onClick={onNavigate} className={primary ? styles.primary : styles.link}>
      {label}<ArrowRight size={17} aria-hidden />
    </Link>
  );
  const section = (name: string, eyebrow: string, title: string, body: string, children: ReactNode) => (
    <section id={`${id}-${name}`} data-chapter={name} tabIndex={-1} className={styles.section} aria-labelledby={`${id}-${name}-title`}>
      <p className={styles.eyebrow}>{eyebrow}</p>
      <h2 id={`${id}-${name}-title`} className={styles.title}>{title}</h2>
      <p className={styles.body}>{body}</p>
      {children}
    </section>
  );
  const scoreFactors = [
    { key: 'preference', weight: SPOT_WEIGHTS.preference, icon: Heart },
    { key: 'time', weight: SPOT_WEIGHTS.time, icon: Footprints },
    { key: 'incentive', weight: SPOT_WEIGHTS.incentive, icon: Ticket },
  ] as const;
  const sources = [
    { key: 'sourceTour', icon: Compass }, { key: 'sourceStats', icon: Database },
    { key: 'sourceParking', icon: MapPin }, { key: 'sourceRoute', icon: Route },
  ] as const;
  const steps = [
    { key: 'stepTaste', href: '/setup', icon: Heart },
    { key: 'stepCompare', href: '/main', icon: MapPin },
    { key: 'stepCourse', href: '/course', icon: Route },
  ] as const;
  const roles = [
    { key: 'tourist', href: '/main', icon: Compass },
    { key: 'merchant', href: '/merchant', icon: Store },
    { key: 'admin', href: '/admin/dashboard', icon: Building2 },
    { key: 'resident', href: null, icon: Home },
  ] as const;
  const pilotPhases = [
    { key: 'pilot14', weeks: '1–4' },
    { key: 'pilot58', weeks: '5–8' },
    { key: 'pilot912', weeks: '9–12' },
  ] as const;
  const businessStages = [
    { key: 'businessB2b', timing: '2027 H1' },
    { key: 'businessB2g', timing: '2027 H2' },
    { key: 'businessData', timing: '2028+' },
  ] as const;
  const signatures = [
    { key: 'sigPredict', icon: Timer },
    { key: 'sigIncentive', icon: Sparkles },
    { key: 'sigVoice', icon: Mic },
    { key: 'sigConsole', icon: Building2 },
    { key: 'sigLearning', icon: Radar },
    { key: 'sigBarrierFree', icon: Accessibility },
  ] as const;
  const features = [
    { key: 'featureMap', href: '/main', icon: MapPin },
    { key: 'featureTime', href: '/waiting', icon: Timer },
    { key: 'featureCourse', href: '/course', icon: Route },
    { key: 'featureSaved', href: '/saved', icon: Bookmark },
    { key: 'featureCoupons', href: '/mypage/coupons', icon: Ticket },
    { key: 'featureImpact', href: '/mypage/impact', icon: Waypoints },
    { key: 'featureSettings', href: '/mypage/settings', icon: Globe },
    { key: 'featureAccount', href: '/mypage', icon: User },
  ] as const;

  return (
    <div ref={rootRef} className={styles.guide}>
      <div className={styles.topline}><span>{t('guide.hint')}</span><LanguageSwitcher /></div>
      <section className={styles.hero}>
        <p className={styles.eyebrow}>{t('guide.eyebrow')}</p>
        <h1 className={styles.heroTitle}>{t('guide.heroTitle')}</h1>
        <p className={styles.heroBody}>{t('guide.heroBody')}</p>
        <div className={styles.actions}>
          {cta('/main', t('guide.explore'), true)}
          <button type="button" onClick={() => jump('story')} className={styles.link}>{t('guide.read')}<ArrowDown size={17} /></button>
        </div>
        <div className={styles.heroArt} aria-hidden="true">
          <svg viewBox="0 0 920 310" className={styles.landscape}>
            <path d="M0 280 Q150 50 310 280 Q420 120 550 280 Q750 15 920 280 V310 H0Z" fill="currentColor" opacity=".09" />
            <path d="M0 310 Q195 120 370 310 Q650 95 920 310Z" fill="currentColor" opacity=".12" />
            <path d="M185 230 C280 300 280 120 460 165 S660 310 750 145" fill="none" stroke="var(--color-gold)" strokeWidth="3" strokeDasharray="7 9" />
            <circle cx="185" cy="230" r="8" fill="var(--color-jade)" /><circle cx="460" cy="165" r="8" fill="var(--color-gold)" /><circle cx="750" cy="145" r="8" fill="var(--color-terracotta)" />
          </svg>
          <div className={`${styles.placePill} ${styles.pillOne}`}><Coffee size={19} />{t('guide.mapCafe')}</div>
          <div className={`${styles.placePill} ${styles.pillTwo}`}><Footprints size={19} />{t('guide.mapWalk')}</div>
          <div className={`${styles.placePill} ${styles.pillThree}`}><Compass size={19} />{t('guide.mapCulture')}</div>
        </div>
      </section>
      <nav className={styles.chapters} aria-label={t('guide.toc')}>
        {chapters.map(([key, label], index) => <button key={key} type="button" onClick={() => jump(key)}><span>0{index + 1}</span>{t(`guide.${label}`)}</button>)}
      </nav>

      {section('story', `01 / ${t('guide.navStory')}`, t('guide.storyTitle'), `${t('guide.problem')} ${t('guide.storyBody')}`,
        <>
          <blockquote className={styles.storyQuote}><Quote size={22} aria-hidden /><p>{t('guide.storyQuote')}</p><cite>{t('guide.storyOrigin')}</cite></blockquote>
          <figure className={styles.storyMap}>
            <div className={styles.origin}><MapPin size={26} /><strong>{t('guide.mapOrigin')}</strong><span>{t('guide.sameExperience')}</span></div>
            <div className={styles.branches} aria-hidden="true"><span /><span /><span /></div>
            <div className={styles.destinations}>{[Coffee, Footprints, Compass].map((Icon, index) => <div key={index}><Icon size={28} /><strong>{t(`guide.${['mapCafe', 'mapWalk', 'mapCulture'][index]}`)}</strong></div>)}</div>
            <figcaption>{t('guide.mapCaption')}</figcaption>
          </figure>
        </>
      )}

      {section('score', `02 / ${t('guide.navScore')}`, t('guide.scoreTitle'), t('guide.scoreBody'), <>
        <div className={styles.factorGrid}>{scoreFactors.map(({ key, weight, icon: Icon }, index) => <article key={key} className={styles.factor}>
          <Icon size={26} /><span className={styles.weight}>{index === 1 ? '−' : '+'}{Math.round(weight * 100)}<small>%</small></span>
          <h3>{t(`guide.${key}`)}</h3><p>{t(`guide.${key}Body`)}</p>
        </article>)}</div>
        <details className={styles.details}><summary>{t('guide.formulaLabel')}</summary>
          <p className={styles.formula}>{SPOT_WEIGHTS.preference} × {t('guide.preference')} − {SPOT_WEIGHTS.time} × {t('guide.time')} + {SPOT_WEIGHTS.incentive} × {t('guide.incentive')}</p>
          <p>{t('guide.formulaNote')}</p>
        </details>
      </>)}

      {section('data', `03 / ${t('guide.navData')}`, t('guide.dataTitle'), t('guide.dataBody'), <>
        <div className={styles.sourceGrid}>{sources.map(({ key, icon: Icon }, index) => <article key={key} className={styles.source}>
          <div className={styles.sourceTop}><Icon size={23} /><span>0{index + 1}</span></div>
          <h3>{t(`guide.${key}`)}</h3><p>{t(`guide.${key}Body`)}</p>
        </article>)}</div>
        <p className={styles.note}>{t('guide.dataOther')}</p>
        <div className={styles.evidenceAction}><p>{t('guide.evidenceAction')}</p>{cta('/main', t('guide.touristCta'))}</div>
        <div className={styles.trust}><h3><ShieldCheck size={22} />{t('guide.trustTitle')}</h3>
          <div className={styles.trustGrid}>{['observed', 'estimated', 'unknown'].map((key, index) => <div key={key}>
            <span className={styles.trustBadge} data-kind={index}>{t(`guide.${key}`)}</span><p>{t(`guide.${key}Body`)}</p>
          </div>)}</div>
        </div>
      </>)}

      {section('journey', `04 / ${t('guide.navJourney')}`, t('guide.journeyTitle'), t('guide.journeyBody'), <>
        <div className={styles.steps}>{steps.map(({ key, href, icon: Icon }, index) => <article key={key}>
          <div className={styles.stepNumber}>0{index + 1}<Icon size={25} /></div>
          <h3>{t(`guide.${key}`)}</h3><p>{t(`guide.${key}Body`)}</p>{cta(href, t('guide.openFeature'))}
        </article>)}</div>
        <p className={styles.note}>{t('guide.journeyNote')}</p>
        <div className={styles.visitLoop}>
          <h3>{t('guide.loopTitle')}</h3>
          <ol>{['loopChoose', 'loopNavigate', 'loopArrive', 'loopFeedback'].map((key, index) => <li key={key}><span>{index + 1}</span>{t(`guide.${key}`)}{index < 3 && <ArrowRight size={15} aria-hidden />}</li>)}</ol>
          <p>{t('guide.loopBody')}</p>
        </div>
      </>)}

      {section('impact', `05 / ${t('guide.navImpact')}`, t('guide.impactTitle'), t('guide.impactBody'), <>
        <div className={styles.roles}>{roles.map(({ key, href, icon: Icon }) => <article key={key}>
          <Icon size={30} /><h3>{t(`guide.${key}`)}</h3><p>{t(`guide.${key}Body`)}</p>{href && cta(href, t(`guide.${key}Cta`))}
        </article>)}</div>
        <p className={styles.note}>{t('guide.roleRequired')}</p>
        <details className={styles.details}><summary>{t('guide.validationTitle')}</summary><p>{t('guide.validationBody')}</p>{cta('/login?next=%2Fadmin%2Fengine-validation', t('guide.validationLink'))}</details>
        <div className={styles.pilot}>
          <div className={styles.planHeading}><Sparkles size={25} /><div><span>{t('guide.planBadge')}</span><h3>{t('guide.pilotTitle')}</h3></div></div>
          <p>{t('guide.pilotBody')}</p>
          <div className={styles.timeline}>{pilotPhases.map(({ key, weeks }) => <article key={key}>
            <span>{t('guide.weeks', { weeks })}</span><h3>{t(`guide.${key}`)}</h3><p>{t(`guide.${key}Body`)}</p>
          </article>)}</div>
          <p className={styles.channelNote}>{t('guide.pilotChannels')}</p>
        </div>
        <details className={`${styles.details} ${styles.roadmap}`}><summary>{t('guide.businessTitle')}</summary>
          <p>{t('guide.businessIntro')}</p>
          <div className={styles.businessGrid}>{businessStages.map(({ key, timing }) => <article key={key}>
            <span>{timing} · {t('guide.planBadge')}</span><h3>{t(`guide.${key}`)}</h3><p>{t(`guide.${key}Body`)}</p>
          </article>)}</div>
          <p>{t('guide.futureBody')}</p>
        </details>
        <details className={`${styles.details} ${styles.team}`}><summary>{t('guide.teamTitle')}</summary>
          <p>{t('guide.teamBody')}</p>
        </details>
      </>)}

      <section data-chapter="features" tabIndex={-1} className={styles.section} aria-labelledby={`${id}-features-title`}>
        <p className={styles.eyebrow}>06 / {t('guide.navFeatures')}</p><h2 id={`${id}-features-title`} className={styles.title}>{t('guide.featuresTitle')}</h2>
        <div className={styles.signature}>
          <p className={styles.signatureHeading}>{t('guide.signatureTitle')}</p>
          <div className={styles.signatureGrid}>{signatures.map(({ key, icon: Icon }) => <article key={key}>
            <Icon size={22} /><h3>{t(`guide.${key}`)}</h3><p>{t(`guide.${key}Body`)}</p>
          </article>)}</div>
        </div>
        <div className={styles.features}>{features.map(({ key, href, icon: Icon }) => <details key={key} className={styles.feature}>
          <summary><Icon size={21} /><span>{t(`guide.${key}`)}</span><span className={styles.plus} aria-hidden>+</span></summary>
          <div><p>{t(`guide.${key}Body`)}</p>{cta(href, t('guide.openFeature'))}</div>
        </details>)}</div>
      </section>
      <footer className={styles.footer}><Check size={30} /><h2>{t('guide.endTitle')}</h2><p>{t('guide.endBody')}</p>
        <div className={styles.actions}>{cta('/main', t('guide.explore'), true)}{onNavigate && cta('/guide', t('guide.direct'))}</div>
        <span className={styles.signature}>NextSpot · Gyeongju</span>
      </footer>
    </div>
  );
}
