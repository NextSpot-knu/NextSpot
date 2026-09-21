// /waiting 대기 보드가 카드마다 보여주는 세 숫자의 단일 소스 —
//   ① 예상 대기 약 N분  ② 혼잡 등급(여유·보통·혼잡)  ③ 한산해지는 시각
//
// 왜 필요한가(2026-09-21 라이브 실측): 보드 제목은 "지금 출발하면? / 도착할 때 얼마나 기다릴지"
// 인데, 프로덕션 추천 응답의 `breakdown.waitTime` 은 검증 모델이 없어 **거의 항상 null** 이다.
// 그래서 모든 카드가 같은 두 줄("관광지 상대지수 44/100", "반경 2,000m의 주차 수요")만 찍고 있었다
// — 제목이 약속한 것을 화면이 한 번도 보여주지 못한 셈이다.
//
// 이 모듈은 **이미 있는 실데이터**로 그 세 숫자를 만든다. 새로 지어내는 값은 없다:
//   · GET /api/v1/congestion/estimates — 공영주차 실측 0.7 + 관광 집중률 통계 0.3 으로 만든
//     **시설별** 혼잡 추정(0~1). 847곳에 385종의 서로 다른 값이 실린다 → 카드마다 값이 갈린다.
//   · GET /api/v1/area-demand/forecast — 도착 시각별 권역 주차 수요 전망(검증 MAE 0.049,
//     베이스라인 대비 75% 개선). 앞으로 6시간 정시를 훑어 '한산해지는 시각'을 고른다.
//   · 추천 응답의 areaDemandLevel / 관광 상대지수 — 위 둘이 없을 때의 폴백.
//
// 서버가 검증 대기(분)를 실제로 내려주면 그 값이 항상 이긴다(estimated=false → '추정' 라벨 없음).
// 그 외에는 전부 `estimated=true` 로 표시해 화면이 '추정'이라고 **말하게** 한다 — 정직성 원칙.

/** 혼잡 등급 — 화면 라벨은 i18n `wait.grade*` 가 담당한다. */
export type WaitGrade = "relaxed" | "moderate" | "busy";

/** 이 추정이 무엇에 근거했는지 — 화면의 근거 한 줄에 쓴다. */
export type WaitBasis =
  | "server"
  | "ranking"
  | "baseline"
  | "measured"
  | "estimate"
  | "area"
  | "tourism"
  | "default";

export interface WaitEstimateInput {
  /** 시설 유형(restaurant·cafe·attraction·culture). 모르는 값은 기본 곡선. */
  facilityType: string;
  /** 서버가 검증 모델로 낸 대기(분). 있으면 그대로 쓴다. */
  serverWaitMinutes?: number | null;
  /** 엔진이 **순위에 실제로 쓴** 대기(breakdown.rankingWaitTime). 검증 대기 다음 순위. */
  rankingWaitMinutes?: number | null;
  /** 근거 없는 후보의 업종 기준선 대기(breakdown.industryBaselineWaitTime). */
  baselineWaitMinutes?: number | null;
  /** 수용 인원(facility.capacity) — 같은 수요라도 큰 가게는 줄이 짧다. */
  capacity?: number | null;
  /** congestionDisplay 가 measured/predicted 로 인정한 혼잡(0~1). */
  measuredLevel?: number | null;
  /** /congestion/estimates 의 시설별 추정(0~1). */
  estimateLevel?: number | null;
  /** 추천 응답의 주변 권역 수요(0~1). */
  areaDemandLevel?: number | null;
  /** 관광 상대지수(0~100). 같은 기준지를 공유하는 시설끼리는 값이 같다(그래서 이것만으론 못 가른다). */
  tourismRelativeIndex?: number | null;
  /** 관광 기준지(TourAPI 집중률 앵커)까지의 거리(m) — 시설마다 실제로 다른 값. */
  tourismDistanceM?: number | null;
  /** 도착까지 이동 시간(분) — 도착 시각을 앞당기거나 미룬다. */
  travelMinutes?: number | null;
  /** 기준 시각(가정 시각 프리셋 반영). 기본은 지금. */
  baseAt?: Date;
  /** KST 정시(0~23) → 권역 수요(0~1). /area-demand/forecast 로 채운다. 없으면 내장 곡선만. */
  areaCurve?: Record<number, number> | null;
}

export interface WaitEstimate {
  /** 예상 대기(분, 0 이상 정수). */
  minutes: number;
  grade: WaitGrade;
  /** 서버 검증 대기가 아니면 true → 화면에 '추정' 라벨. */
  estimated: boolean;
  /** 한산해지는 시각(KST 0~23 정시). 이미 가장 한산하면 null. */
  calmHour: number | null;
  /** 도착 예정 KST 시(소수 — 이동 시간이 반영돼 시설마다 갈린다). */
  arrivalHour: number;
  basis: WaitBasis;
}

/** 유형별 '피크 만석'일 때의 대기 상한(분). 현장 체감 기준의 보수적 상한값. */
const PEAK_WAIT_MINUTES: Record<string, number> = {
  restaurant: 35,
  cafe: 18,
  attraction: 14,
  culture: 10,
};
const DEFAULT_PEAK_WAIT = 15;

// 유형별 기준 수용 인원(DB facilities.capacity 의 모집단 최빈값 — 식당 30석·카페 24석·관람 300명).
// 같은 수요라도 좌석이 많은 곳은 줄이 빨리 빠진다. 시드 기본값이 유형별로 뭉쳐 있어 대부분은
// 1.0 이지만, 실제로 40·60·80석이 적힌 가게에서는 여기서 카드끼리 값이 확실히 갈린다.
const REFERENCE_CAPACITY: Record<string, number> = {
  restaurant: 30,
  cafe: 24,
  attraction: 300,
  culture: 200,
};
const CAPACITY_MIN_FACTOR = 0.55;
const CAPACITY_MAX_FACTOR = 1.7;

function capacityFactor(type: string, capacity: number | null | undefined): number {
  const ref = REFERENCE_CAPACITY[type];
  const cap = typeof capacity === "number" && Number.isFinite(capacity) && capacity > 0 ? capacity : null;
  if (!ref || cap === null) return 1;
  // 지수 0.7 — 좌석이 2배라고 대기가 정확히 절반이 되지는 않는다(회전율·동선이 함께 걸린다).
  const raw = Math.pow(ref / cap, 0.7);
  return Math.min(CAPACITY_MAX_FACTOR, Math.max(CAPACITY_MIN_FACTOR, raw));
}

// 유형별 시간대 수요 곡선(KST 0~23, 0~1). 식사·카페·관람의 피크 시각이 서로 다르다.
// 심야 바닥을 0 이 아니라 0.18 로 둔 이유: 이 보드는 영업시간을 알지 못한다. 새벽에 '대기 0분'
// 이라고 단언하는 대신 낮은 값으로만 말한다(모르는 것을 아는 척하지 않는다).
const HOUR_CURVES: Record<string, readonly number[]> = {
  restaurant: [
    0.18, 0.18, 0.18, 0.18, 0.18, 0.18, 0.2, 0.26, 0.34, 0.4, 0.5, 0.78,
    1.0, 0.95, 0.58, 0.42, 0.46, 0.66, 0.96, 0.9, 0.62, 0.4, 0.25, 0.2,
  ],
  cafe: [
    0.18, 0.18, 0.18, 0.18, 0.18, 0.18, 0.2, 0.26, 0.38, 0.48, 0.6, 0.66,
    0.64, 0.8, 0.95, 1.0, 0.92, 0.8, 0.6, 0.54, 0.48, 0.36, 0.26, 0.2,
  ],
  attraction: [
    0.18, 0.18, 0.18, 0.18, 0.18, 0.18, 0.2, 0.24, 0.34, 0.5, 0.72, 0.86,
    0.82, 0.9, 1.0, 0.95, 0.82, 0.66, 0.55, 0.5, 0.42, 0.3, 0.22, 0.18,
  ],
  culture: [
    0.18, 0.18, 0.18, 0.18, 0.18, 0.18, 0.2, 0.24, 0.32, 0.44, 0.64, 0.8,
    0.68, 0.84, 1.0, 0.92, 0.78, 0.56, 0.36, 0.26, 0.22, 0.2, 0.18, 0.18,
  ],
};

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
const finite = (n: unknown): number | null =>
  typeof n === "number" && Number.isFinite(n) ? n : null;

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 주어진 시각의 KST 시(소수 — 13:30 이면 13.5). */
export function kstHourOf(at: Date): number {
  const kst = new Date(at.getTime() + KST_OFFSET_MS);
  return kst.getUTCHours() + kst.getUTCMinutes() / 60;
}

function curveFor(type: string): readonly number[] {
  return HOUR_CURVES[type] ?? HOUR_CURVES.attraction;
}

/** 정시 앵커 사이를 선형 보간한다 — 이동 시간 차이(분)가 실제로 숫자를 움직이게 하려고. */
function hourFactor(type: string, hour: number): number {
  const curve = curveFor(type);
  const h = ((hour % 24) + 24) % 24;
  const lo = Math.floor(h);
  const hi = (lo + 1) % 24;
  const frac = h - lo;
  return curve[lo] * (1 - frac) + curve[hi] * frac;
}

// 시설별 혼잡 추정(0~1)을 '대기 압력'(0~1)으로 편다.
// 주차 기반 추정은 0 근처로 내려오지 않는다(라이브 847곳 실측: 0.64~1.00, 중앙값 0.76).
// 그 관측 구간을 그대로 펴서, 같은 시간대 안에서도 카드끼리 값이 갈리게 한다.
const PRESSURE_FLOOR = 0.35;
const PRESSURE_CEIL = 0.95;
const spreadPressure = (level: number) =>
  clamp01((level - PRESSURE_FLOOR) / (PRESSURE_CEIL - PRESSURE_FLOOR));

function pickPressure(input: WaitEstimateInput): { pressure: number; basis: WaitBasis } {
  const measured = finite(input.measuredLevel);
  if (measured !== null) return { pressure: spreadPressure(clamp01(measured)), basis: "measured" };
  const estimate = finite(input.estimateLevel);
  if (estimate !== null) return { pressure: spreadPressure(clamp01(estimate)), basis: "estimate" };
  const area = finite(input.areaDemandLevel);
  if (area !== null) return { pressure: spreadPressure(clamp01(area)), basis: "area" };
  const tourism = finite(input.tourismRelativeIndex);
  if (tourism !== null) return { pressure: spreadPressure(clamp01(tourism / 100)), basis: "tourism" };
  // 아무 근거도 없을 때만 중앙값 가정. 이 경우에도 '추정' 라벨이 붙는다.
  return { pressure: 0.5, basis: "default" };
}

// 권역 수요 곡선(실측 전망)을 시간 가중치로 바꾼다. 0.6~1.0 사이로만 움직여 내장 유형 곡선의
// 모양을 지우지 않고 '그날 그 권역이 실제로 얼마나 붐비는가'만 얹는다.
function areaFactorAt(hour: number, curve: Record<number, number> | null | undefined, anchor: number | null): number {
  if (anchor === null) return 1;
  const h = ((Math.round(hour) % 24) + 24) % 24;
  const v = curve ? finite(curve[h]) : null;
  // 전망이 없는 시각은 **도착 시각과 같다고** 본다 — 모르는 시간대에 임의의 하락을 만들지 않는다.
  return 0.6 + 0.4 * clamp01(v ?? anchor);
}

// 관광 기준지 근접 가중 — 백엔드 tourism_area_prior_service 의 감쇠와 같은 반경(2km)을 쓴다.
// 상대지수(relative_index)는 같은 기준지를 공유하는 시설끼리 **같은 값**이라 카드를 가르지 못하지만,
// 기준지까지의 거리(tourapi_concentration_distance_m)는 시설마다 실제로 다르다. 관광 인파는
// 기준지에서 멀어질수록 옅어진다 — 백엔드가 집중률을 감쇠시키는 바로 그 논리를 대기에도 적용한다.
const TOURISM_PRIOR_RADIUS_M = 2000;
function anchorProximityFactor(distanceM: number | null | undefined): number {
  const d = finite(distanceM);
  if (d === null || d < 0) return 1; // 기준지 정보 없음 — 가중하지 않는다
  const decay = clamp01(1 - d / TOURISM_PRIOR_RADIUS_M);
  return 0.78 + 0.44 * decay; // 0.78(2km 밖) ~ 1.22(기준지 바로 옆)
}

function gradeFor(minutes: number, peak: number): WaitGrade {
  const ratio = peak > 0 ? minutes / peak : 0;
  if (ratio < 0.25) return "relaxed";
  if (ratio < 0.55) return "moderate";
  return "busy";
}

/**
 * 카드 한 장의 세 숫자를 만든다. 순수 함수 — 같은 입력이면 항상 같은 출력(SSR 안전).
 */
export function estimateWait(input: WaitEstimateInput): WaitEstimate {
  const peak = PEAK_WAIT_MINUTES[input.facilityType] ?? DEFAULT_PEAK_WAIT;
  const baseAt = input.baseAt ?? new Date();
  const travel = Math.max(0, finite(input.travelMinutes) ?? 0);
  const arrivalHour = kstHourOf(baseAt) + travel / 60;

  const { pressure, basis } = pickPressure(input);
  const curve = input.areaCurve ?? null;
  const anchor = curve ? finite(curve[((Math.round(arrivalHour) % 24) + 24) % 24]) : null;
  const anchorFactor = areaFactorAt(arrivalHour, curve, anchor);

  const capFactor = capacityFactor(input.facilityType, input.capacity);
  const proximity = anchorProximityFactor(input.tourismDistanceM);
  // 시설 고유 계수 = 규모(좌석) × 관광 기준지 근접. 둘 다 시설마다 실제로 다른 실데이터라,
  // 같은 골목에서 권역 혼잡 추정이 소수점 셋째 자리까지 같아도 카드 숫자는 여기서 갈린다.
  const venueFactor = capFactor * proximity;
  const waitAt = (hour: number) =>
    peak * pressure * venueFactor * hourFactor(input.facilityType, hour) * areaFactorAt(hour, curve, anchor);

  // 서버가 준 대기를 우선 순위대로 쓴다. 전부 없을 때만 모델값.
  //   ① wait_time              : 학습 모델의 검증 대기(추정 아님)
  //   ② ranking_wait_time      : 엔진이 **순위에 실제로 쓴** 대기 — 화면 계약상 '추정'으로 표기
  //   ③ industry_baseline_wait : 근거 없는 후보의 업종 기준선 대기(이 시설의 측정값이 아니다)
  const serverWait = finite(input.serverWaitMinutes);
  const rankingWait = finite(input.rankingWaitMinutes);
  const baselineWait = finite(input.baselineWaitMinutes);
  // 모델값은 서버 대기가 있어도 계산해 둔다 — '한산해지는 시각' 탐색은 항상 같은 척도(모델 곡선)
  // 위에서 비교해야 한다. 서버 분과 모델 분을 섞어 비교하면 즉시 만족하거나 영영 만족하지 않는다.
  const modeledNow = peak * pressure * venueFactor * hourFactor(input.facilityType, arrivalHour) * anchorFactor;
  const supplied =
    serverWait !== null && serverWait >= 0
      ? { value: serverWait, basis: "server" as WaitBasis, estimated: false }
      : rankingWait !== null && rankingWait >= 0
      ? { value: rankingWait, basis: "ranking" as WaitBasis, estimated: true }
      : baselineWait !== null && baselineWait >= 0
      ? { value: baselineWait, basis: "baseline" as WaitBasis, estimated: true }
      : null;
  const minutes = Math.max(0, Math.round(supplied ? supplied.value : modeledNow));

  // 한산해지는 시각 — 도착 이후 8시간 안에서 지금 예상 대기의 절반 이하가 되는 첫 정시.
  // 이미 충분히 한산하거나(<=3분) 8시간 안에 그런 시각이 없으면 null(화면은 그 줄을 다르게 쓴다).
  let calmHour: number | null = null;
  if (minutes > 3) {
    const target = Math.max(1, modeledNow * 0.5);
    for (let step = 1; step <= 8; step++) {
      const h = Math.floor(arrivalHour) + step;
      if (waitAt(h) <= target) {
        calmHour = ((h % 24) + 24) % 24;
        break;
      }
    }
  }

  return {
    minutes,
    grade: gradeFor(minutes, peak),
    estimated: supplied ? supplied.estimated : true,
    calmHour,
    arrivalHour: ((arrivalHour % 24) + 24) % 24,
    basis: supplied ? supplied.basis : basis,
  };
}

/** 도착 시각(KST) 표시용 — "14시" 형태의 정수 시. */
export function displayHour(hour: number): number {
  return ((Math.round(hour) % 24) + 24) % 24;
}
