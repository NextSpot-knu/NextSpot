// 비교 헤더(P2) — 카드 첫 줄(가치 문장)을 만들기 위한 **표시 전용** 계산.
//
// 왜 필요한가: 추천 카드는 "우직 · SPOT 74점"으로 시작해, 이 추천이 **무슨 줄을 대신하는지**를
// 접힌 상태에서는 말하지 않았다. 서비스의 약속("줄 서는 대신, 경주를 한 곳 더")이 카드에서
// 사라진 셈이다. 이 모듈은 카드가 이미 받은 값만 재료로 그 한 줄을 만든다 — 새 네트워크 호출도,
// 없는 숫자를 지어내는 일도 없다.
//
// 정직성 규칙 두 가지:
//   1) **등급은 근거가 있을 때만.** 기준 명소의 혼잡을 말할 근거가 하나도 없으면 등급 단어를
//      만들지 않는다(basis === 'none').
//   2) **첫 줄은 사라지지 않는다.** 근거가 전부 없어도 문장은 만들어진다 — 화면에서 줄이
//      나타났다 없어지면 카드 레이아웃이 매번 달라지고, 그게 심사 중 '깨진 화면'으로 읽힌다.
//      비교가 성립하지 않으면 chooseCompareHeadline 이 '혜택 문장'을 고른다(아래).

import {
  areaDemandDisclosure,
  type ParkingDemandEvidence,
  type TourismDemandEvidence,
} from './areaDemandPresentation';
import { DEFAULT_BUSY_THRESHOLD, congestionKey, type CongestionKey } from './congestionScale';
import { congestionDisplay, type CongestionDisplayInput } from './congestionEstimate';

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
  /** 근거가 없으면 null — 비교가 성립하지 않아 카드는 혜택 문장으로 말한다. */
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

/**
 * 기준 명소 시설 자체의 '지금' 혼잡(0~1) — resolveAnchorCrowd 의 1순위 근거(estimateLevel)로 넘길 값.
 * 카드가 후보를 칠할 때와 **같은 규칙**(congestionDisplay)을 거친다: 서버가 '지금이 아니다' 라고 한 24시간
 * 넘은(또는 시각 모를) 관측은 버리고, 추정은 60분 안쪽만 쓴다. 지도 시설 목록의 원시 congestionLevel 을
 * 그대로 읽으면 46일 전 관측 0.92 가 '지금 대릉원 혼잡' 이 된다(검토 2026-10-06).
 */
export function anchorNowLevel(input: CongestionDisplayInput, now: Date = new Date()): number | null {
  const display = congestionDisplay(input, now);
  return display.level ?? display.estimate?.level ?? null;
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
 *  - 주차 근거가 없으면(관광 지수·축제뿐) null — 호출부가 붐빔 등급을 말하지 않는다.
 */
export function candidateAreaCrowdLevel(input: CandidateAreaCrowdInput): number | null {
  if (finite(input.areaDemandLevel) === null) return null;
  if (areaDemandDisclosure(input.parking, input.tourism).showQualitativeLevel) {
    return finite(input.areaDemandLevel);
  }
  return finite(input.parking?.level);
}

/** 후보(추천 장소) 쪽 혼잡 등급. 근거가 하나도 없으면 null — 호출부가 등급 단어를 말하지 않는다. */
export function resolveCandidateCrowd(input: CandidateCrowdInput): CongestionKey | null {
  const busyAt = finite(input.busyAt) ?? DEFAULT_BUSY_THRESHOLD;
  const level = finite(input.congestionLevel)
    ?? finite(input.estimateLevel)
    ?? finite(input.areaDemandLevel);
  return level === null ? null : congestionKey(clamp01(level), busyAt);
}

// ── 카드 첫 줄(가치 문장) 고르기 ─────────────────────────────────────────────
//
// "지금 A 혼잡 → 대신 B" 는 **B 가 정말 A 보다 덜 붐빌 때만** 참이다. 예전 헤더는 언제나 화살표를
// 그려서 "지금 경주 첨성대 혼잡 → 대신 경주 첨성대"(자기 자신과 비교) · "지금 인기 명소 인기 → …"
// (근거 없음) · 혼잡 → 혼잡(같은 지역 추정이라 등급이 같다)처럼 서비스의 약속을 첫 줄에서 스스로
// 깨뜨렸다(심사 시뮬레이션 2026-10-06). 그래서 화살표는 아래 조건이 **모두** 맞을 때만 쓰고,
// 아니면 관광객이 얻는 것(이름 · 도보 N분 · 도착 시 영업 · 취향 N% 일치)을 말한다.
// 기준 명소의 등급이 관광 상대지수에서 왔으면(basis 'tourism') 비교하지 않는다 — 그 지수는 명소마다 자기 최고
// 시기를 100 으로 본 날짜별 값이라 '지금' 도 아니고 다른 곳과 견줄 수도 없다(후보 쪽 candidateAreaCrowdLevel 과 같은 규칙).

/** 지구·일원 같은 넓은 구역 기록 — '대신 피할 한 곳'으로 부를 수 없다. */
const DISTRICT_ANCHOR = /(사적지대|관광단지|유적지구|지구|일원|일대|권역)$/;
/** 이보다 가까우면 같은 자리다 — '대신 가 볼 다른 곳'이 아니다. */
const MIN_ANCHOR_DISTANCE_M = 100;
const GRADE_ORDER: Record<CongestionKey, number> = { quiet: 0, relaxed: 1, moderate: 2, busy: 3 };

/** 이름 비교용 — 공백과 맨 앞 '경주'를 뗀다('첨성대' = '경주 첨성대'). */
function normalizePlaceName(name: string): string {
  return name.replace(/\s+/g, '').replace(/^경주/, '');
}

/** 같은 곳의 다른 표기 — 정규화한 이름과, 괄호 속 별칭('천마총(대릉원)' → '천마총' · '대릉원'). */
function placeNameKeys(name: string): string[] {
  const key = normalizePlaceName(name);
  const alias = key.match(/^(.+?)\((.+)\)$/);
  return (alias ? [key, normalizePlaceName(alias[1]), normalizePlaceName(alias[2])] : [key]).filter(Boolean);
}

export interface CompareHeadlineInput {
  anchorName?: string | null;
  /** 기준 명소와 후보 사이 거리(m). 모르면 null — 거리 조건은 통과로 본다. */
  anchorDistanceM?: number | null;
  candidateName: string;
  anchorGrade: CongestionKey | null;
  /** anchorGrade 를 무엇으로 정했는지(resolveAnchorCrowd). 'tourism' 이면 비교하지 않는다. */
  anchorBasis?: AnchorCrowdBasis;
  candidateGrade: CongestionKey | null;
}

export type CompareHeadline =
  /** "지금 {A} {등급} → 대신 {B} · 도보 N분 · {등급}" — B 가 정말 덜 붐빌 때만. */
  | { kind: 'compare' }
  /** "{B} · 도보 N분 · 도착 시 영업 · 취향 N% 일치". candidateIsAnchor 면 머리표가 '지금 가까운 추천'이다. */
  | { kind: 'benefit'; candidateIsAnchor: boolean };

export function chooseCompareHeadline(input: CompareHeadlineInput): CompareHeadline {
  const anchor = input.anchorName?.trim() ?? '';
  const distance = finite(input.anchorDistanceM);
  const anchorKeys = placeNameKeys(anchor);
  const candidateKeys = placeNameKeys(input.candidateName);
  const anchorKey = normalizePlaceName(anchor);
  const candidateKey = normalizePlaceName(input.candidateName);
  // '경주' 처럼 정규화하면 빈 이름이 되는 기록은 기준 명소가 아니다(빈 문자열은 모든 이름에 들어 있다).
  const hasAnchor = anchorKey !== '';
  const farApart = distance !== null && distance >= MIN_ANCHOR_DISTANCE_M;
  // 같은 곳: 이름(또는 괄호 속 별칭)이 같다, 또는 거리가 0 — 관광 근거가 그 장소 자신의 기록과 맞물리면
  // 서버가 거리 0 으로 준다. 한쪽 이름이 다른 쪽을 품는 것('첨성대' ⊂ '첨성대 한정식')은 거리를 모르거나
  // 100m 안쪽일 때만 같은 곳으로 본다 — 300m 떨어진 '첨성대 한정식' 은 첨성대가 아니다.
  const candidateIsAnchor = hasAnchor && (
    anchorKeys.some((key) => candidateKeys.includes(key))
    || (!farApart && candidateKey !== '' && (anchorKey.includes(candidateKey) || candidateKey.includes(anchorKey)))
    || (distance !== null && distance < 1)
  );
  const calmer = input.anchorGrade !== null
    && input.candidateGrade !== null
    && GRADE_ORDER[input.candidateGrade] < GRADE_ORDER[input.anchorGrade];
  if (
    hasAnchor
    && !DISTRICT_ANCHOR.test(anchor)
    && !candidateIsAnchor
    && (distance === null || distance >= MIN_ANCHOR_DISTANCE_M)
    && input.anchorBasis !== 'tourism'
    && calmer
  ) {
    return { kind: 'compare' };
  }
  return { kind: 'benefit', candidateIsAnchor };
}

/**
 * 혜택 문장의 '취향 N% 일치' 는 이 값 이상일 때만 붙인다. 칩이 온보딩 밖 유형도 고르게 된 뒤(A5) 서로 무관한
 * 메뉴는 12~18% 가 나와, 카드에서 가장 큰 줄이 "취향 12% 일치" 처럼 추천한 곳을 스스로 깎는 말이 됐다.
 */
export const TASTE_BENEFIT_MIN_PERCENT = 50;

/** 혜택 문장에 붙일 취향 일치율(정수 %). 정수가 아니거나 문턱 아래면 null — 그 조각을 빼고 말한다. */
export function tasteBenefitPercent(preferencePercent: number | null | undefined): number | null {
  return typeof preferencePercent === 'number'
    && Number.isInteger(preferencePercent)
    && preferencePercent >= TASTE_BENEFIT_MIN_PERCENT
    ? preferencePercent
    : null;
}

/**
 * 앞면(가치 문장 · 미리보기 · 음성 이유 · 대안 카드 칩)에서 취향 일치율을 말하는 문턱(리뷰 10-07). 처음 고른 취향만 있는
 * 게스트는 음식점·관광지·대안 다섯 곳 모두 '취향 51% 일치' 처럼 같은 숫자가 나와 개인화가 꾸민 숫자처럼 보였다.
 */
export const TASTE_FACE_MIN_PERCENT = 60;

/**
 * 앞면에 말할 취향 일치율 — 그 숫자가 장소를 가를 때만. ① 60% 이상이고 ② 함께 보이는 후보들(peers, 자신 포함)이 모두
 * 같은 숫자가 아닐 때. 아니면 null — 그 조각을 빼고 말한다('취향이 안 맞아요' 같은 말을 대신 하지 않는다).
 * 숫자 자체는 SPOT 점수 상자('내 취향 · N% 일치')와 근거 안에 그대로 남는다.
 */
export function faceTastePercent(
  preferencePercent: number | null | undefined,
  peers: readonly (number | null | undefined)[] = [],
): number | null {
  const pct = tasteBenefitPercent(preferencePercent);
  if (pct === null || pct < TASTE_FACE_MIN_PERCENT) return null;
  const known = peers.filter((p): p is number => typeof p === 'number' && Number.isFinite(p)).map((p) => Math.round(p));
  if (known.length >= 2 && known.every((p) => p === pct)) return null;
  return pct;
}

// ── 접힌 카드 얼굴의 혼잡 칩 ─────────────────────────────────────────────────────────────────────
//
// 계획 B2 5번: 얼굴의 칩은 가치 문장이 이미 한 말을 되풀이하지 않는다. 혼잡 칩은 (a) 지금 잰 값이 있거나
// (b) 이 후보가 기준 명소보다 **정말** 덜 붐빌 때만 얼굴에 둔다. 주변 공영주차로 만든 지역 추정은 근처 장소가
// 모두 같은 등급을 받는다 — 얼굴에 두면 '대안' 이 피하려던 곳과 똑같이 붐벼 보인다(그 근거는 '추천 근거 자세히' 안).

export interface FaceCrowdChipInput {
  /** 가치 문장이 이미 두 곳의 붐빔을 말하는가(화살표 문장). 그러면 칩은 같은 말의 반복이다. */
  valueLineSaysCrowd: boolean;
  /** 카드가 '지금' 실측으로 칠한 값이 있는가(서버가 '지금' 이라 한 관측 · 방금 남긴 제보). */
  measuredNow: boolean;
  anchorGrade: CongestionKey | null;
  /** anchorGrade 를 무엇으로 정했는지. 관광 상대지수면 '덜 붐빈다' 를 말하지 않는다(화살표와 같은 규칙). */
  anchorBasis?: AnchorCrowdBasis;
  candidateGrade: CongestionKey | null;
}

export function showFaceCrowdChip(input: FaceCrowdChipInput): boolean {
  if (input.valueLineSaysCrowd) return false;
  if (input.measuredNow) return true;
  return input.anchorBasis !== 'tourism'
    && input.anchorGrade !== null
    && input.candidateGrade !== null
    && GRADE_ORDER[input.candidateGrade] < GRADE_ORDER[input.anchorGrade];
}
