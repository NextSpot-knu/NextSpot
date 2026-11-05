// 혼잡 등급 → 칩 클래스, 추정(주차 실측 기반) 노출 판정 — 웹 course/page.tsx 의 CONGESTION_CLASS·congestion·stopEstimate (기준 커밋 0d145a1).
// 경주 한 곳만 서비스하므로 내부 검증 지역(구역 근거 zoneEvidence)의 단계 경계 분기는 옮기지 않는다.
// 숫자(%)는 어디에도 말하지 않는다 — 등급 단어와 색만 쓴다.
import { congestionKey, type CongestionKey } from '@/lib/congestionScale';

import { displayableEstimate } from './evidence';

/** 등급별 칩 클래스(바탕·테두리·글자) — 불투명 꼬리(/10 /25)는 hex 토큰에만 붙인다. */
export const CONGESTION_CLASS: Record<CongestionKey, string> = {
  busy: 'border-terracotta/25 bg-terracotta/10',
  moderate: 'border-gold/25 bg-gold/10',
  relaxed: 'border-jade/25 bg-jade/10',
  quiet: 'border-jade/30 bg-jade/15',
};

/** 칩 글자 클래스 — 바탕과 따로 둔다(Text 는 글자 색을 자기 className 으로만 받는다). */
export const CONGESTION_TEXT_CLASS: Record<CongestionKey, string> = {
  busy: 'text-terracotta',
  moderate: 'text-gold-deep',
  relaxed: 'text-jade',
  quiet: 'text-jade',
};

export function congestionOf(level: number, busyAt: number): CongestionKey {
  return congestionKey(level, busyAt);
}

/** 정류지·대안의 보여도 되는 추정. 예측 수치가 있으면 null, 60분 넘게 낡았으면 null. 공유로 복원한 정류지에는 추정이 없다. */
export function stopEstimate(s: { predictedCongestion: number | null; congestionEstimate?: unknown }) {
  return displayableEstimate({
    congestionLevel: s.predictedCongestion,
    congestionEstimate: s.congestionEstimate,
  });
}
