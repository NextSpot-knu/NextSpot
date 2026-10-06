// 사장님 콘솔 ① 예상 혼잡 → '가장 한가한 시간' 한 줄 제안(순수 함수, 렌더 없음).
//
// 곡선만 보여 주면 사장님이 '그래서 언제?' 를 직접 읽어 내야 한다. 앞으로 6시간 중 가장 한가할 시각을 골라
// '그때 타임세일을 열어 보세요' 로 이어 준다. 고르는 점은 **차트가 그리는 바로 그 점들 전체**에서의 최저점이다 —
// 리뷰 10-07: 06:50 에 영업 시간대(10~21시) 안에서만 최저를 골라 '10시가 가장 한가할 것 같아요' 라고 했는데, 바로 아래
// 차트는 지금 6% → 10시 33% → 12시 55% 로 오르기만 해서 콜아웃이 자기 차트와 어긋났다. 이제 그 최저점이 영업 시간대
// 밖(새벽·심야)이면 콜아웃을 띄우지 않는다(그 시각엔 손님을 모을 일이 없다). 곡선이 평평하면(최대 − 최소 < 0.15)
// 고를 이유가 없으니 아무것도 제안하지 않는다.

import type { HourlyCongestionPoint } from './api';

/** 제안 대상 시각(KST, 포함). 이 밖의 새벽·심야는 한가해도 손님을 모을 시간이 아니다. */
export const QUIET_HOUR_FIRST = 10;
export const QUIET_HOUR_LAST = 21;
/** 이만큼은 차이가 나야 '이때가 한가하다' 고 말할 수 있다(혼잡도 0..1 기준). */
export const QUIET_HOUR_MIN_SPREAD = 0.15;

export interface QuietHour {
  hour: number;
  hoursAhead: number;
  congestion: number;
  /** 가장 한가한 때가 바로 지금인가. */
  isNow: boolean;
}

const inOpenHours = (p: HourlyCongestionPoint) => p.hour >= QUIET_HOUR_FIRST && p.hour <= QUIET_HOUR_LAST;

/**
 * 차트가 그리는 점들 중 가장 한가한 점 — 그 점이 영업 시간대(10~21시) 안일 때만. 영업 시간대 점이 둘 미만이거나,
 * 최저점이 영업 시간대 밖이거나, 곡선이 평평하면 null. 같은 최저가 여럿이면 가장 이른 점(차트의 왼쪽).
 */
export function bestQuietHour(points: readonly HourlyCongestionPoint[]): QuietHour | null {
  if (points.filter(inOpenHours).length < 2) return null;
  let min = points[0];
  let max = points[0].congestion;
  for (const p of points) {
    if (p.congestion < min.congestion) min = p;
    if (p.congestion > max) max = p.congestion;
  }
  // 차트에서 가장 낮은 점이 새벽·심야면 '그때 타임세일' 은 말이 안 되고, 영업 시간대의 다른 점을 고르면 차트와 어긋난다.
  if (!inOpenHours(min)) return null;
  // 부동소수 잡음(0.6 − 0.45 = 0.1499…)으로 경계가 흔들리지 않게 소수 셋째 자리에서 비교한다.
  if (Math.round((max - min.congestion) * 1000) / 1000 < QUIET_HOUR_MIN_SPREAD) return null;
  return { hour: min.hour, hoursAhead: min.hoursAhead, congestion: min.congestion, isNow: min.hoursAhead === 0 };
}

/** 콜아웃 문구(사장님 콘솔은 한국어 전용). */
export function quietHourCopy(quiet: QuietHour): { title: string; body: string } {
  return quiet.isNow
    ? { title: '지금이 가장 한가한 시간이에요', body: '지금 타임세일을 열어 손님을 모아 보세요.' }
    : {
        title: `${quiet.hour}시가 가장 한가할 것 같아요`,
        body: '이 시간에 타임세일을 열면 손님을 더 모을 수 있어요.',
      };
}
