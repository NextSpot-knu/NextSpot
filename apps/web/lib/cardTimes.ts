// 추천 카드의 시간 숫자들 — 큰 숫자 · 칩 · 출발→도착 타임라인이 **한 규칙**으로 같은 말을 하게 한다.
//
// 왜 필요한가: 카드는 큰 숫자를 timeToService 반올림으로(2.4분 → '총 소요 시간 2분'), 바로 아래 칩은
// 도보 분 올림으로('이동 3분') 그렸다. 캡처한 카드 상태의 절반이 "총 2분 / 이동 3분" 이었고, 타임라인
// 도착 시각은 반올림 전 분을 더해 "12:24 출발 → 12:24 도착 · 이동 1분" 이 되기도 했다(심사 시뮬레이션
// 2026-10-06). 여기서는 화면에 보이는 분만 더한다 — 큰 숫자는 언제나 칩의 합이다.
//
// timeToService 는 순위 입력으로만 남는다(이 모듈은 읽지 않는다). 지도에서 고른 카드는 그 안에 화면에
// 보이지 않는 혼잡 대기가 섞여 있어 "총 16분 · 이동 3분" 처럼 설명되지 않는 숫자가 됐다.

import { displayWalkingMinutes } from './recommender';

export interface CardTimes {
  /** 칩·타일·타임라인이 쓰는 도보 분(올림, 최소 1). */
  walkMin: number;
  /** 화면에 보이는 대기 분(올림). 보여 줄 대기가 없으면 null — 타일 제목이 '도보 시간' 이 된다. */
  waitMin: number | null;
  /** walkMin + 보이는 대기. 칩의 합과 언제나 같다. */
  totalMin: number;
  /** 출발 + 도보 칩 분. 출발 시각을 모르면 null. */
  arrival: Date | null;
  /** 도착 + 보이는 대기(대기가 있을 때만). */
  service: Date | null;
}

export function cardTimes(
  expectedTravel: number | null | undefined,
  expectedWait: number | null | undefined,
  depart: Date | null,
): CardTimes {
  const walkMin = displayWalkingMinutes(expectedTravel ?? 0);
  const waitMin = typeof expectedWait === 'number' && Number.isFinite(expectedWait)
    ? Math.max(0, Math.ceil(expectedWait))
    : null;
  const totalMin = walkMin + (waitMin ?? 0);
  const arrival = depart ? new Date(depart.getTime() + walkMin * 60_000) : null;
  const service = arrival && waitMin !== null ? new Date(arrival.getTime() + waitMin * 60_000) : null;
  return { walkMin, waitMin, totalMin, arrival, service };
}
