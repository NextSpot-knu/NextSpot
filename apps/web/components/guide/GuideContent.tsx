'use client';

import Link from 'next/link';
import {
  ArrowRight, BarChart3, Building2, ChevronDown, Clock, Compass, Handshake, Home, Landmark, MapPin, Route, Store,
} from 'lucide-react';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { useT } from '@/lib/i18n/I18nProvider';
import FeatureShortcuts from './FeatureShortcuts';
import GuideDataSection from './GuideDataSection';
import GuideHero from './GuideHero';
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

      {/* 첫 화면 = 데스크톱 랜딩과 같은 히어로 — 오른쪽 칸은 핵심 기능 다섯 개로 바로 가는 '이렇게 써 보세요'
          (2026-10-06 감사 PH07: 소개 첫 화면에 '무엇을 눌러 볼지'가 없었다). */}
      <GuideHero
        lead={<p className={styles.eyebrow}>{t('guide.eyebrow')}</p>}
        cta={(
          <Link href="/setup" prefetch={false} onClick={onNavigate} className={styles.primary}>
            {t('guide.explore')}<ArrowRight size={18} aria-hidden />
          </Link>
        )}
        aside={<FeatureShortcuts onNavigate={onNavigate} />}
      />

      {/* 문제 → 해결 판은 한 절 아래로 내려왔다 — 히어로 오른쪽 칸을 기능 지도에 내주었다. */}
      <section className={`${styles.section} ${styles.answerSection}`}>
        <div className={styles.sectionInner}>
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
          {/* 콘솔 버튼은 데모로 바로 가므로, 실제 계정으로 들어갈 길을 따로 잇는다 — 사장님 콘솔은 로그인 화면으로 곧장
              (?next=/merchant 라 심사용 사장님 계정이 이메일 칸에 미리 들어간다), 관제는 관문(/admin/login)으로.
              계정 안내는 그 관문과 로그인 화면이 맡는다(components/JudgeAccountHint.tsx). 소개 본문에는 심사 문구를 두지 않는다. */}
          <p className={styles.note}>
            {t('dataTab.roleNote')}
            {/* 링크는 문장 아래 줄에 — 같은 줄에 이어 붙이면 문장과 링크가 한 문장처럼 읽힌다. */}
            <span className={styles.noteLinks}>
              <Link href="/login?next=/merchant" prefetch={false} onClick={onNavigate} className={styles.noteLink}>
                {t('guide.consoleLoginMerchant')}
              </Link>
              {' · '}
              <Link href="/admin/login" prefetch={false} onClick={onNavigate} className={styles.noteLink}>
                {t('guide.consoleLoginAdmin')}
              </Link>
            </span>
          </p>
        </div>
      </section>

      {/* 데이터 절 — '어떤 공공 API 를 어디에 쓰는가'를 한 표로. 홈 푸터의 데이터 출처 줄이
          이 절을 펼친 채로 연다(lib/guideDataSection.ts). 계획 절과 같은 접힘 문법. */}
      <GuideDataSection />

      {/* 실행 계획(12주 실증·사업 모델)은 맨 아래 접힘으로 — 관심 있는 심사위원만 펼쳐 본다.
          기본 접힘(<details>)이라 키보드·스크린리더 접근이 그대로 동작한다. */}
      <details className={styles.planFold} data-plan-fold>
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
            {/* 서울 실측 검증 카드는 뺐다 — 경주 서비스 소개에 서울 데이터가 보이면 경주를 서울 기준으로 맞춘 것처럼
                읽혔다(2026-10-06 감사 I07). 검증 화면은 관제 콘솔 URL(/admin/engine-validation)에 그대로 있다. */}
          </div>
        </section>
      </details>
    </div>
  );
}
