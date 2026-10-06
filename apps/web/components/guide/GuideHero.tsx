'use client';

// 서비스 소개(모달·/guide)와 데스크톱 랜딩(≥1024px)이 함께 쓰는 두 칸 히어로.
//
// 왜 하나로 뽑았나(2026-10-06 감사 I35·PH07): 데스크톱 첫 화면은 420px 폰 세로 줄이었고, 정작 소개 모달에만
// 두 칸 히어로가 있었다. 심사위원이 가장 먼저 보는 화면이 자기 모달보다 약했다. 이제 같은 히어로가 랜딩이 되고,
// 오른쪽 칸은 두 곳 모두 '이렇게 써 보세요'(FeatureShortcuts) — 핵심 기능 다섯 개로 바로 가는 줄이다.
// 왼쪽 칸의 머리(lead)·주 행동(cta)·그 아래(children)만 화면마다 다르다.

import type { ReactNode } from 'react';
import { useT } from '@/lib/i18n/I18nProvider';
import styles from './guide.module.css';

export default function GuideHero({ lead, cta, children, aside, variant = 'guide' }: {
  /** 제목 위 — 소개는 eyebrow 문장, 랜딩은 로고와 지역 배지. */
  lead: ReactNode;
  /** 주 행동 — 소개는 /setup 링크, 랜딩은 '바로 시작'(재방문자는 /main 으로). */
  cta: ReactNode;
  /** 주 행동 아래 — 랜딩의 축제 배너·데이터 띠·로그인/서비스 소개 줄. */
  children?: ReactNode;
  /** 오른쪽 칸. */
  aside: ReactNode;
  /** landing: 화면 높이를 채우고 노트북 창(1366×650·1536×730)에 맞춰 글자를 한 단계 줄인다. */
  variant?: 'guide' | 'landing';
}) {
  const t = useT();
  return (
    <section className={variant === 'landing' ? `${styles.hero} ${styles.heroLanding}` : styles.hero}>
      <div className={styles.heroLayout}>
        <div className={styles.heroCopy}>
          {lead}
          <h1 className={styles.heroTitle}>{t('guide.heroTitle')}</h1>
          <p className={styles.heroBody}>{t('guide.heroBody')}</p>
          {cta}
          {children}
        </div>
        <div className={styles.heroAside}>{aside}</div>
      </div>
    </section>
  );
}
