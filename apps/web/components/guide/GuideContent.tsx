'use client';

import Link from 'next/link';
import {
  ArrowRight, BarChart3, Building2, ChevronDown, Clock, Compass, Handshake, Home, Landmark, MapPin, Route, Store,
} from 'lucide-react';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { useT } from '@/lib/i18n/I18nProvider';
import GuideDataSection from './GuideDataSection';
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

const pilotPhases = [
  { key: 'pilot14', weeks: '1~4' },
  { key: 'pilot58', weeks: '5~8' },
  { key: 'pilot912', weeks: '9~12' },
] as const;

const businessModels = [
  { key: 'businessB2b', icon: Handshake },
  { key: 'businessB2g', icon: Building2 },
  { key: 'businessData', icon: BarChart3 },
] as const;

const ecosystemRoles = [
  { key: 'tourist', icon: Compass },
  { key: 'merchant', icon: Store },
  { key: 'admin', icon: Landmark },
  { key: 'resident', icon: Home },
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

      {/* 생태계(지역과 함께) 절이 계획 절 자리를 이어받는다(PM 지시 2026-09-21) —
          심사 동선에서 '누구에게 무엇이 좋아지는가' 가 실행 계획보다 먼저 읽혀야 한다. */}
      <section className={styles.section} aria-labelledby="nextspot-impact">
        <div className={styles.sectionInner}>
          <p className={styles.kicker}>{t('guide.navImpact')}</p>
          <h2 id="nextspot-impact" className={styles.sectionTitle}>{t('guide.impactTitle')}</h2>
          <p className={styles.sectionBody}>{t('guide.impactBody')}</p>
          <ul className={styles.roleGrid}>
            {ecosystemRoles.map(({ key, icon: Icon }) => (
              <li key={key} className={styles.roleCard}>
                <Icon size={22} aria-hidden />
                <h3>{t(`guide.${key}`)}</h3>
                <p className={styles.cardBody}>{t(`guide.${key}Body`)}</p>
              </li>
            ))}
          </ul>
          {/* 로그인 벽 대신 데모 라우트로 — 심사위원이 계정 없이 상인·관제 화면을 바로 본다
              (?demo=1 은 각 콘솔이 읽는 읽기 전용 데모 플래그). */}
          <div className={styles.ctaRow}>
            <Link href="/merchant?demo=1" prefetch={false} onClick={onNavigate} className={styles.consoleCta}>
              {t('dataTab.merchantCta')}<ArrowRight size={16} aria-hidden />
            </Link>
            <Link href="/admin/dashboard?demo=1" prefetch={false} onClick={onNavigate} className={styles.consoleCta}>
              {t('dataTab.adminCta')}<ArrowRight size={16} aria-hidden />
            </Link>
          </div>
          <p className={styles.note}>{t('dataTab.roleNote')}</p>
        </div>
      </section>

      {/* 데이터 절 — '어떤 공공 API 를 어디에 쓰는가'를 한 표로. 홈 푸터의 데이터 출처 줄이
          이 절을 펼친 채로 연다(lib/guideDataSection.ts). 계획 절과 같은 접힘 문법. */}
      <GuideDataSection />

      {/* 실행 계획(12주 실증·사업 모델)은 맨 아래 접힘으로 — 관심 있는 심사위원만 펼쳐 본다.
          기본 접힘(<details>)이라 키보드·스크린리더 접근이 그대로 동작한다. */}
      <details className={styles.planFold}>
        <summary className={styles.planSummary}>
          <span>{t('guide.planBadge')}</span>
          <ChevronDown size={18} aria-hidden />
        </summary>

        <section className={styles.section} aria-labelledby="nextspot-pilot">
          <div className={styles.sectionInner}>
            <p className={styles.kicker}>{t('guide.planBadge')}</p>
            <h2 id="nextspot-pilot" className={styles.sectionTitle}>{t('guide.pilotTitle')}</h2>
            <p className={styles.sectionBody}>{t('guide.pilotBody')}</p>
            <ol className={styles.timeline}>
              {pilotPhases.map(({ key, weeks }, index) => (
                <li key={key} className={styles.timelineCard}>
                  <span className={styles.stepBadge} aria-hidden>{index + 1}</span>
                  <div>
                    <p className={styles.weeksTag}>{t('guide.weeks', { weeks })}</p>
                    <h3>{t(`guide.${key}`)}</h3>
                    <p className={styles.cardBody}>{t(`guide.${key}Body`)}</p>
                  </div>
                </li>
              ))}
            </ol>
            <p className={styles.note}>{t('guide.pilotChannels')}</p>
          </div>
        </section>

        <section className={`${styles.section} ${styles.sectionAlt}`} aria-labelledby="nextspot-business">
          <div className={styles.sectionInner}>
            <p className={styles.kicker}>{t('guide.planBadge')}</p>
            <h2 id="nextspot-business" className={styles.sectionTitle}>{t('guide.businessTitle')}</h2>
            <p className={styles.sectionBody}>{t('guide.businessIntro')}</p>
            <ul className={styles.modelGrid}>
              {businessModels.map(({ key, icon: Icon }) => (
                <li key={key} className={styles.modelCard}>
                  <Icon size={22} aria-hidden />
                  <h3>{t(`guide.${key}`)}</h3>
                  <p className={styles.cardBody}>{t(`guide.${key}Body`)}</p>
                </li>
              ))}
            </ul>
            <p className={styles.future}>{t('guide.futureBody')}</p>

            {/* 추정 엔진의 정확도를 '계획'이 아니라 '지금 돌아가는 일'로 보여주는 카드.
                서울 검증 현황 API(GET /engine-validation/seoul/status)는 관리자 인증이 필요해
                여기서 호출하지 않는다 — 수집 대상·주기는 고정 사실이라 정적 문장으로 적는다
                (app/services/seoul_citydata_service.py · docs/CONGESTION_ENGINE_PLAN.md §5.1). */}
            <div className={styles.seoulCard}>
              <span className={styles.seoulBadge}>{t('dataTab.seoulBadge')}</span>
              <h3>{t('dataTab.seoulTitle')}</h3>
              <p className={styles.cardBody}>{t('dataTab.seoulBody')}</p>
            </div>
          </div>
        </section>
      </details>
    </div>
  );
}
