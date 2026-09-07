// 관리자 리포트의 '이용량' 집계 — 순수 판정만 모은다.
//
// 왜 빼냈나: 이 화면의 숫자가 **두 가지로 거짓말을 하고 있었다.**
//
// 1) `총 이용량(명)` 은 방문자 수가 아니었다. `congestion_logs.current_count` 의 **단순 합**인데,
//    그 값은 한 로그 행의 순간 재실 인원 추정치다. 그래서 **같은 시설의 로그가 많을수록 커진다** —
//    제보가 잦은 인기 시설은 하루에 로그가 20개, 조용한 시설은 2개다. 사람 수가 아니라
//    '누가 얼마나 자주 제보했는가' 를 재고 있었던 셈이다.
//    → 합을 내기 전에 **(시설, 30분 버킷)당 하나**로 접는다(중앙값). 그러면 로그 빈도 편향이
//      사라지고, 남는 값의 뜻이 "관측된 시설-시간 조각들의 혼잡 추정 합" 으로 분명해진다.
//      (로그 유효기간(TTL)을 거는 방법도 있지만 그건 이 편향을 못 잡는다 — 원인이 '오래된
//       로그' 가 아니라 '시설마다 쌓이는 빈도가 다르다' 이기 때문이다.)
//
// 2) 전주 표본이 없으면 **측정하지 않은 '+100% 급증' 을 지어냈다.** `prev > 0 ? … : cur > 0 ? 100 : 0`
//    → 전주 관측이 0건이면 비교 자체가 불가능하다. 없는 비교를 만들지 않고 `null` 로 닫는다.
//
// 단위도 '명' 이 아니다. 접어도 여전히 재실 인원 **추정치**의 합이라 사람 수로 읽으면 안 된다.
// 화면 라벨은 '관측 혼잡 지수' 로 부르고, 근거(관측 버킷 수)를 함께 보여 준다.

/** 30분 — 이 저장소가 다른 곳에서 관측을 묶는 단위와 같다(확증 승격 트리거·학습 버킷). */
export const OBSERVATION_BUCKET_MS = 30 * 60 * 1000;

export interface ObservationRow {
  facilityId: string | null;
  timestamp: string;
  currentCount: number | null;
}

export interface FoldedObservation {
  facilityId: string;
  bucketMs: number;
  /** 그 시설·그 30분의 재실 추정 중앙값. */
  level: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * (시설, 30분 버킷)당 하나로 접는다. 같은 조각의 여러 관측은 **중앙값**으로 대표한다.
 *
 * 중앙값인 이유: 한 조각 안에서 튀는 제보 하나가 그 조각을 통째로 끌고 가지 않게. 평균이면
 * 이상치 하나가 그대로 반영되고, 최댓값이면 '가장 붐빈다고 말한 사람' 만 남는다.
 *
 * `facilityId`/`currentCount` 가 없는 행은 **버린다.** 0 으로 채우면 있지도 않은 관측을
 * 만들어 내고, 그건 이 파일이 고치려는 바로 그 문제다.
 */
export function foldObservations(rows: readonly ObservationRow[]): FoldedObservation[] {
  const groups = new Map<string, { facilityId: string; bucketMs: number; values: number[] }>();
  for (const row of rows) {
    if (!row.facilityId) continue;
    if (typeof row.currentCount !== 'number' || !Number.isFinite(row.currentCount)) continue;
    const ts = new Date(row.timestamp).getTime();
    if (!Number.isFinite(ts)) continue;
    const bucketMs = Math.floor(ts / OBSERVATION_BUCKET_MS) * OBSERVATION_BUCKET_MS;
    const key = `${row.facilityId}@${bucketMs}`;
    const found = groups.get(key);
    if (found) found.values.push(row.currentCount);
    else groups.set(key, { facilityId: row.facilityId, bucketMs, values: [row.currentCount] });
  }
  return [...groups.values()].map((g) => ({
    facilityId: g.facilityId,
    bucketMs: g.bucketMs,
    level: median(g.values),
  }));
}

export interface GrowthVerdict {
  /** 비교 불가면 null — 화면은 이때 '—' 를 그리고 배지를 내지 않는다. */
  percent: number | null;
  /** 비교 불가면 null. */
  status: '급증' | '활발' | '보통' | '둔화' | null;
  /** 왜 비교할 수 없는지(있을 때만). */
  reason: 'no_previous_observation' | null;
}

/**
 * 전주 대비 증감. **전주 관측이 없으면 비교하지 않는다.**
 *
 * 예전에는 `prev > 0 ? … : cur > 0 ? 100 : 0` 이라 전주 표본이 없으면 무조건 `+100%` + '급증'
 * 배지가 붙었다. 그 상황이 드물지도 않다 — 조회가 상한에서 잘리면 최신순이라 **잘리는 쪽이
 * 언제나 전주 구간**이라, 잘렸다는 신호도 없이 모든 카테고리가 '+100% 급증' 이 됐다.
 */
export function describeGrowth(cur: number, prev: number, prevBucketCount: number): GrowthVerdict {
  if (prevBucketCount <= 0 || prev <= 0) {
    return { percent: null, status: null, reason: 'no_previous_observation' };
  }
  const percent = Math.round(((cur - prev) / prev) * 100);
  const status = percent >= 20 ? '급증' : percent >= 5 ? '활발' : percent >= -5 ? '보통' : '둔화';
  return { percent, status, reason: null };
}
