// 경주 **추정 모드** — 주차 실측 + 관광 통계로 만든 시설별 혼잡 추정의 화면 계약.
//
// 백엔드(app/services/congestion_estimator_service.py)가 `congestion_estimate` 로 싣는 값이다.
// 실측이 아니다. 이 모듈이 지키는 선은 셋이다:
//
//   1) **따로 둔다.** 추정은 `congestionLevel`·`baseCongestion`·`currentCount` 에 절대 들어가지
//      않는다. 그 필드들은 클라 미러(lib/recommender.ts 의 scoreFacility)가 실측처럼 대기 분을
//      계산하고, 히트맵·저장 북마크·음성 후보가 '관측' 으로 읽는 자리다. 한 번 섞이면 추정이
//      실측 등급(measured_rules)으로 순위를 얻고 '예상 대기 n분' 으로 팔린다.
//   2) **낡으면 버린다.** 시설 목록은 localStorage 에 24시간 캐시된다(main 의 FACILITY_CACHE).
//      어제 밤 캐시가 첫 화면에 그려질 때 그 추정을 '지금' 으로 보여 주면 이 모드가 막으려던
//      바로 그 거짓말이 된다. 백엔드가 스냅샷을 60분까지만 '지금' 으로 인정하므로(MAX_SNAPSHOT_AGE)
//      화면도 같은 선을 쓴다 — 오래 열어 둔 탭도 같은 이유로 걸러진다.
//   3) **실측·예측이 있으면 말하지 않는다.** 서버가 이미 그 규칙으로 내려주지만(측정 > 예측 > 추정),
//      화면 쪽에서도 한 번 더 막는다. 두 숫자가 한 카드에 나란히 뜨면 사용자는 어느 쪽이
//      지금인지 고를 수 없다.

import type { CongestionEstimate } from './api-client';

/** 백엔드 parking_derived_congestion_service.MAX_SNAPSHOT_AGE 와 같은 선(60분). */
export const ESTIMATE_MAX_AGE_MS = 60 * 60 * 1000;

// 미래 시각 허용 폭. 서버·기기 시계가 몇 분 어긋나는 건 흔하다 — 그걸로 추정을 지우지는 않되,
// 한참 미래(=파싱 오류나 잘못된 값)는 '지금' 이라고 믿지 않는다.
const FUTURE_SKEW_MS = 5 * 60 * 1000;

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 응답의 추정 한 건을 검증한다. 모양이 어긋나거나 낡았으면 `null`.
 *
 * 구 서버(필드 자체가 없음)·오염된 캐시·스냅샷 60분 초과는 전부 `null` 로 떨어진다 —
 * 그때 화면은 오늘과 같은 '근거 없음' 으로 그린다. 모르면 그리지 않는다.
 */
export function parseCongestionEstimate(raw: unknown, now: Date = new Date()): CongestionEstimate | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.source !== 'estimated') return null;
  const level = finite(r.level);
  if (level === null || level < 0 || level > 1) return null;
  if (typeof r.observedAt !== 'string' || !r.observedAt) return null;
  const observedMs = new Date(r.observedAt).getTime();
  if (Number.isNaN(observedMs)) return null;
  const age = now.getTime() - observedMs;
  if (age > ESTIMATE_MAX_AGE_MS || age < -FUTURE_SKEW_MS) return null;
  const parkingLevel = finite(r.parkingLevel);
  const tourismLevel = finite(r.tourismLevel);
  const lotCount = finite(r.lotCount);
  const nearestLotM = finite(r.nearestLotM);
  const radiusM = finite(r.radiusM);
  return {
    level,
    source: 'estimated',
    observedAt: r.observedAt,
    parkingLevel: parkingLevel ?? level,
    tourismLevel,
    lotCount: lotCount !== null ? Math.max(0, Math.round(lotCount)) : 0,
    nearestLotM,
    radiusM: radiusM !== null && radiusM > 0 ? radiusM : 2000,
  };
}

/**
 * 화면에 **보여도 되는** 추정. 실측·예측 숫자가 있으면 `null` 이다(웹 쪽 우선순위 가드).
 *
 * `congestionSource` 가 'measured'/'predicted' 이거나 `congestionLevel` 이 숫자면 그 값이 이긴다.
 * 서버가 이미 같은 규칙으로 내려주므로 정상 경로에서는 걸릴 일이 없다 — 걸린다면 두 경로
 * (예: 사용자가 방금 남긴 로컬 제보)가 겹친 것이고, 그때 추정을 숨기는 쪽이 맞다.
 */
export function displayableEstimate(input: {
  congestionLevel?: number | null;
  congestionSource?: string | null;
  congestionEstimate?: unknown;
}, now: Date = new Date()): CongestionEstimate | null {
  if (typeof input.congestionLevel === 'number' && Number.isFinite(input.congestionLevel)) return null;
  if (input.congestionSource === 'measured' || input.congestionSource === 'predicted') return null;
  return parseCongestionEstimate(input.congestionEstimate, now);
}

/**
 * 추정 피드(GET /congestion/estimates) 응답 → {facilityId: 원본 추정}. 모양이 어긋나면 빈 객체.
 *
 * 값 하나하나는 여기서 검증하지 않는다 — 신선도(60분)는 **그릴 때의 시각**으로 봐야 하므로
 * 소비처가 parseCongestionEstimate/displayableEstimate 를 매번 다시 부른다. 여기서 한 번 걸러
 * 저장하면 5분 뒤·30분 뒤의 화면이 받아 온 순간의 판정을 그대로 믿게 된다.
 * `available: false`(스냅샷 낡음·수집 실패)·구 서버 404·e2e 스텁의 `[]` 는 전부 '추정 없음'.
 */
export function estimatesFromFeed(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const p = payload as { available?: unknown; estimates?: unknown };
  if (p.available !== true) return {};
  const e = p.estimates;
  if (!e || typeof e !== 'object' || Array.isArray(e)) return {};
  return e as Record<string, unknown>;
}

/** 관측 시각을 경주 현지(KST) 'HH:MM' 으로. 기기 시간대와 무관하게 같은 문자열이다. */
export function formatEstimateTime(observedAt: string | null | undefined): string | null {
  if (!observedAt) return null;
  const ms = new Date(observedAt).getTime();
  if (Number.isNaN(ms)) return null;
  const kst = new Date(ms + 9 * 60 * 60 * 1000);
  const hh = String(kst.getUTCHours()).padStart(2, '0');
  const mm = String(kst.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** 반경(m) → km 표기용 숫자. 2000 → 2, 1500 → 1.5. */
export function estimateRadiusKm(radiusM: number | null | undefined): number {
  const m = typeof radiusM === 'number' && Number.isFinite(radiusM) && radiusM > 0 ? radiusM : 2000;
  return Math.round((m / 1000) * 10) / 10;
}
