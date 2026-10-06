'use client';

// '이렇게 써 보세요' — 기능설명서 §5 의 핵심 기능 1~5 로 바로 가는 다섯 줄(2026-10-06 감사 PE06·PH07).
//
// 데스크톱 랜딩과 서비스 소개 히어로의 오른쪽 칸(GuideHero). 1~4번은 줄 전체가 /main 링크이고(?focus 로
// 그 기능에 불을 켠다), 5번은 사장님 콘솔 · 관제 대시보드 두 버튼이다 — 랜딩에서 콘솔로 가는 입구는 이것 하나.
// 목적지 규칙은 lib/featureShortcuts.ts(역할이 맞으면 실제 콘솔, 아니면 데모).
// 이미 /main 위(지도 화면 레일의 '서비스 소개' 모달)에서 1~4번을 누르면 주소를 바꾸지 않고 모달을 닫은 뒤
// 'nextspot:main-focus' 이벤트를 쏜다 — 같은 화면 안의 이동은 지도 화면을 다시 마운트하지 않아 ?focus 가 안 읽힌다.

import { useId, type MouseEvent } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Building2, ChevronRight, Compass, Landmark, Map as MapIcon, Mic, RefreshCw, Store, type LucideIcon } from 'lucide-react';
import { useT } from '@/lib/i18n/I18nProvider';
import { useAccount } from '@/lib/account';
import { featureShortcuts, isMainPath, requestMainFocus, type FeatureShortcutKey } from '@/lib/featureShortcuts';
import styles from './guide.module.css';

const ICONS: Record<FeatureShortcutKey, LucideIcon> = {
  forecast: MapIcon,
  card: Compass,
  live: RefreshCw,
  voice: Mic,
  console: Building2,
};

export default function FeatureShortcuts({ onNavigate }: { onNavigate?: () => void }) {
  const t = useT();
  const { account } = useAccount();
  const rows = featureShortcuts(account);
  // 랜딩 위에 소개 모달을 열면 같은 목록이 두 번 그려진다 — 제목 id 가 겹치지 않게 인스턴스마다 만든다.
  const headingId = useId();
  const onMain = isMainPath(usePathname());

  return (
    <section className={styles.shortcuts} aria-labelledby={headingId}>
      <div className={styles.shortcutsHead}>
        <h2 id={headingId} className={styles.shortcutsTitle}>{t('featureMap.title')}</h2>
        <p className={styles.shortcutsHint}>{t('featureMap.hint')}</p>
      </div>
      <ol className={styles.shortcutList}>
        {rows.map((row, index) => {
          const Icon = ICONS[row.key];
          const text = (
            <>
              <span className={styles.shortcutIcon} aria-hidden><Icon size={20} /></span>
              <span className={styles.shortcutText}>
                <span className={styles.shortcutLabel}>
                  <span className={styles.shortcutNum} aria-hidden>{index + 1}</span>
                  {t(`featureMap.${row.key}.label`)}
                </span>
                <span className={styles.shortcutDesc}>{t(`featureMap.${row.key}.desc`)}</span>
              </span>
            </>
          );
          if (row.consoles) {
            return (
              <li key={row.key} className={`${styles.shortcutRow} ${styles.shortcutRowConsoles}`} data-shortcut={row.key}>
                {text}
                <span className={styles.shortcutConsoles}>
                  <Link href={row.consoles.merchant} prefetch={false} onClick={onNavigate} className={styles.shortcutConsole}>
                    <Store size={15} aria-hidden />{t('nav.merchantConsole')}
                  </Link>
                  <Link href={row.consoles.admin} prefetch={false} onClick={onNavigate} className={styles.shortcutConsole}>
                    <Landmark size={15} aria-hidden />{t('nav.adminDashboard')}
                  </Link>
                </span>
              </li>
            );
          }
          const key = row.key;
          const onRowClick = (event: MouseEvent<HTMLAnchorElement>) => {
            if (onMain && key !== 'console') {
              event.preventDefault();
              onNavigate?.();
              requestMainFocus(key);
              return;
            }
            onNavigate?.();
          };
          return (
            <li key={row.key}>
              <Link href={row.href ?? '/main'} prefetch={false} onClick={onRowClick} className={styles.shortcutRow} data-shortcut={row.key}>
                {text}
                <ChevronRight size={18} aria-hidden className={styles.shortcutChevron} />
              </Link>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
