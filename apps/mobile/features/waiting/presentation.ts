// 대기 보드 카드의 문구·색 결정 — 웹 apps/web/app/waiting/page.tsx 의 waitHeadline · headlineTone · gradeBadgeClass ·
// basisKey · headlineOf 를 React 없이 옮겼다(테스트: presentation.test.ts). 무엇을 말할지는 `@/lib/boardOrder` waitHeadlineOf 가
// 정한다(줄 세우기의 동점 판정과 같은 결과).
import type { CongestionKey } from '@/lib/congestionScale';
import { waitHeadlineOf, type WaitHeadline } from '@/lib/boardOrder';
import type { WaitEstimate } from '@/lib/waitEstimate';

import { displayWalkingMinutes, type BoardRow } from './boardData';

export type TFn = (key: string, vars?: Record<string, string | number>) => string;

/** 칩 한 개의 색 — NativeWind 클래스 쌍(바탕·테두리)과 글자색 토큰. jade 는 hex 토큰이라 /n 을 붙일 수 있다. */
export interface Tone {
  box: string;
  text: string;
  dashed?: boolean;
}

const RELAXED: Tone = { box: 'bg-jade/10 border-jade/30', text: 'text-jade' };
const MODERATE: Tone = { box: 'bg-gold/10 border-gold/30', text: 'text-gold-deep' };
const BUSY: Tone = { box: 'bg-terracotta/10 border-terracotta/30', text: 'text-terracotta' };

export function gradeTone(grade: NonNullable<WaitEstimate['grade']>): Tone {
  return grade === 'busy' ? BUSY : grade === 'moderate' ? MODERATE : RELAXED;
}

/** 붐빔 등급(한산·여유·보통·혼잡) → 3색. 한산·여유는 jade 하나. */
export function crowdTone(key: CongestionKey): Tone {
  return key === 'busy' ? BUSY : key === 'moderate' ? MODERATE : RELAXED;
}

export function headlineOf(
  est: WaitEstimate,
  row: Pick<BoardRow, 'areaDemandLevel' | 'areaDemandTourismEvidence'>,
  estimateLevel: number | undefined,
  busyAt: number,
): WaitHeadline {
  return waitHeadlineOf(
    est,
    {
      estimateLevel,
      areaDemandLevel: row.areaDemandLevel,
      tourismRelativeIndex: row.areaDemandTourismEvidence?.relativeIndex ?? null,
    },
    busyAt,
  );
}

/** 주인공 한 줄의 색. 추정(분 없이 등급만 · 추정 분)은 점선 테두리. */
export function headlineTone(h: WaitHeadline, est: WaitEstimate): Tone {
  switch (h.kind) {
    case 'minutes':
      return { ...gradeTone(est.grade ?? 'moderate'), dashed: est.estimated };
    case 'noWait':
    case 'relaxed':
      return RELAXED;
    case 'estimate':
    case 'area':
      return { ...crowdTone(h.level), dashed: true };
    default:
      return { box: 'bg-gold/10 border-gold/30', text: 'text-gold-deep', dashed: true };
  }
}

/** 카드의 주인공 한 줄 문구. 근거가 없으면 null — 0분을 만들지 않는다. */
export function headlineText(h: WaitHeadline, t: TFn): string | null {
  switch (h.kind) {
    case 'minutes':
      return t('wait.minutes', { n: h.n });
    case 'noWait':
      return t('wait.noWait');
    case 'relaxed':
      return t('wait.grade.relaxed');
    case 'estimate':
      return t('card.estimateLevel', { label: t(`congestion.${h.level}`) });
    case 'area':
      return `${t('recommend.areaDemand')}: ${t(`congestion.${h.level}`)}`;
    case 'tourism':
      return t('recommend.tourismEvidenceIndex', { n: h.n });
    default:
      return null;
  }
}

export function walkText(row: Pick<BoardRow, 'expectedTravel'>, t: TFn): string {
  return t('wait.walk', { n: displayWalkingMinutes(row.expectedTravel) });
}

/** 숫자의 근거 한 줄 키. */
export function basisKey(basis: WaitEstimate['basis']): string {
  switch (basis) {
    case 'server': return 'wait.basisServer';
    case 'ranking': return 'wait.basisRanking';
    case 'baseline': return 'wait.basisBaseline';
    case 'measured': return 'wait.basisMeasured';
    case 'estimate': return 'wait.basisEstimate';
    case 'area': return 'wait.basisArea';
    case 'tourism': return 'wait.basisTourism';
    default: return 'wait.basisDefault';
  }
}

/** 카드가 보드 전체 맥락에서 어떻게 그려지는가(웹 CardDisplay) — 다 찬 보드가 한 등급일 때만 바뀐다. */
export interface CardDisplay {
  walk: boolean;
  hideCalm: boolean;
}
export const PLAIN_DISPLAY: CardDisplay = { walk: false, hideCalm: false };

/** 대표 카드의 근거 줄: '12:20 도착 예측 · 근거' 또는 근거가 없으면 '12:20 도착'. */
export function arrivalLine(est: WaitEstimate, display: CardDisplay, arrivalTime: string, t: TFn): string {
  return est.basis === 'default' || display.walk
    ? t('wait.arrivalOnly', { time: arrivalTime })
    : `${t('wait.arrivalBasis', { time: arrivalTime })} · ${t(basisKey(est.basis))}`;
}

/** 캐러셀 위치 안내('2 / 3'). */
export function positionLabel(index: number, count: number): string {
  return `${index + 1} / ${count}`;
}

/** 스크롤 위치 → 지금 몇 번째 카드인가(0 시작). */
export function activeIndexFromOffset(offsetX: number, step: number, count: number): number {
  if (step <= 0 || count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, Math.round(offsetX / step)));
}
