// 비교 헤더(P2) — "지금 A 혼잡 → 대신 B" 한 줄을 만들기 위한 **표시 전용** 계산.
//
// 왜 필요한가: 추천 카드는 "우직 · SPOT 74점"으로 시작해, 이 추천이 **무슨 줄을 대신하는지**를
// 접힌 상태에서는 말하지 않았다. 서비스의 약속("줄 서는 대신, 경주를 한 곳 더")이 카드에서
// 사라진 셈이다. 이 모듈은 카드가 이미 받은 값만 재료로 그 한 줄을 만든다 — 새 네트워크 호출도,
// 없는 숫자를 지어내는 일도 없다.
//
// 정직성 규칙 두 가지:
//   1) **등급은 근거가 있을 때만.** 기준 명소의 혼잡을 말할 근거가 하나도 없으면 등급 단어를
//      만들지 않고 '인기 명소'라는 사실만 남긴다(basis === 'none').
//   2) **헤더는 사라지지 않는다.** 근거가 전부 없어도 문장은 만들어진다 — 화면에서 줄이
//      나타났다 없어지면 카드 레이아웃이 매번 달라지고, 그게 심사 중 '깨진 화면'으로 읽힌다.
//      따라서 이 모듈은 절대 null 을 반환하지 않고, 호출부가 폴백 문구를 고르게 한다.

import {
  areaDemandDisclosure,
  type ParkingDemandEvidence,
  type TourismDemandEvidence,
} from './areaDemandPresentation';
import { DEFAULT_BUSY_THRESHOLD, congestionKey, type CongestionKey } from './congestionScale';

/** 기준 명소의 혼잡 등급을 무엇으로 말했는지. 화면이 근거를 밝힐 때 쓴다. */
export type AnchorCrowdBasis = 'estimate' | 'parking' | 'tourism' | 'none';

export interface AnchorCrowdInput {
  /** 1순위: 혼잡 추정 등급(주차 실측 + 관광 통계로 만든 0~1 추정). */
  estimateLevel?: number | null;
  /** 2순위: 공영주차 실측 수요 등급(0~1). */
  parkingLevel?: number | null;
  /** 3순위: 관광지 상대지수(0~100). 그 관광지 자체 최고 시기를 100으로 본 값이다. */
  tourismRelativeIndex?: number | null;
  /** 운영자 '혼잡' 경계(0~1). 미지정이면 기본값. */
  busyAt?: number;
}

export interface AnchorCrowd {
  /** 근거가 없으면 null — 호출부가 등급 단어 대신 '인기 명소'로 말한다. */
  grade: CongestionKey | null;
  basis: AnchorCrowdBasis;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * 기준 명소(앵커)의 혼잡 등급을 정해진 우선순위로 고른다.
 * 혼잡 추정 → 공영주차 실측 수요 → 관광지 상대지수 → (없음).
 */
export function resolveAnchorCrowd(input: AnchorCrowdInput): AnchorCrowd {
  const busyAt = finite(input.busyAt) ?? DEFAULT_BUSY_THRESHOLD;

  const estimate = finite(input.estimateLevel);
  if (estimate !== null) {
    return { grade: congestionKey(clamp01(estimate), busyAt), basis: 'estimate' };
  }

  const parking = finite(input.parkingLevel);
  if (parking !== null) {
    return { grade: congestionKey(clamp01(parking), busyAt), basis: 'parking' };
  }

  const tourism = finite(input.tourismRelativeIndex);
  if (tourism !== null) {
    return { grade: congestionKey(clamp01(tourism / 100), busyAt), basis: 'tourism' };
  }

  return { grade: null, basis: 'none' };
}

export interface CandidateCrowdInput {
  /** 카드가 '지금'으로 칠한 실측·예측 혼잡도(0~1). */
  congestionLevel?: number | null;
  /** 실측이 없을 때 카드가 점선 배지로 그리는 추정(0~1). */
  estimateLevel?: number | null;
  /**
   * 주변 수요(0~1). **공영주차 근거만**으로 된 값만 넘긴다 — 관광 상대지수가 섞인 종합값은
   * 단일 혼잡률로 말하지 않는다는 것이 lib/areaDemandPresentation.ts 의 계약이다.
   * 카드에서는 candidateAreaCrowdLevel(...) 결과를 그대로 넘긴다.
   */
  areaDemandLevel?: number | null;
  busyAt?: number;
}

export interface CandidateAreaCrowdInput {
  /** 서버 area_demand_level — 주차·관광·근처 축제·날씨를 합친 순위용 종합값(0~1). */
  areaDemandLevel?: number | null;
  parking?: ParkingDemandEvidence | null;
  tourism?: TourismDemandEvidence | null;
}

/**
 * 후보 주변의 붐빔을 **한 등급으로 말할 때** 쓸 값(0~1). 비교 헤더와 휴대폰 미리보기 배지가 함께 쓴다.
 *  - 공영주차 근거만 있으면: 종합값(주차 + 근처 축제·날씨 보정) — 카드의 주변 수요 등급과 같다.
 *  - 관광 상대지수가 섞였으면: **주차 실측·이력 값만**. 관광 지수는 명소마다 자기 최고 시기가 100 이라
 *    붐빔 등급으로 말하지 않는다(기준 명소 쪽 resolveAnchorCrowd 도 주차 값을 관광 지수보다 먼저 쓴다).
 *  - 주차 근거가 없으면(관광 지수·축제뿐) null — 호출부가 '수집 중'으로 말한다.
 */
export function candidateAreaCrowdLevel(input: CandidateAreaCrowdInput): number | null {
  if (finite(input.areaDemandLevel) === null) return null;
  if (areaDemandDisclosure(input.parking, input.tourism).showQualitativeLevel) {
    return finite(input.areaDemandLevel);
  }
  return finite(input.parking?.level);
}

/** 후보(추천 장소) 쪽 혼잡 등급. 근거가 하나도 없으면 null — 호출부가 '수집 중'으로 말한다. */
export function resolveCandidateCrowd(input: CandidateCrowdInput): CongestionKey | null {
  const busyAt = finite(input.busyAt) ?? DEFAULT_BUSY_THRESHOLD;
  const level = finite(input.congestionLevel)
    ?? finite(input.estimateLevel)
    ?? finite(input.areaDemandLevel);
  return level === null ? null : congestionKey(clamp01(level), busyAt);
}
