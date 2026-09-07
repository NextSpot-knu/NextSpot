// 혼잡 등급 경계 — 화면들이 각자 하드코딩하던 `0.75` 를 한 곳으로 모은다.
//
// 왜 필요한가: '혼잡' 을 몇 %부터로 볼지는 운영자가 정하는 값이다(관리자 설정
// congestionThreshold, 0~100 정수). 그런데 경계가 화면마다 리터럴로 박혀 있으면 설정을
// 바꿔도 아무 화면도 따라오지 않는다 — 설정이 있는데 아무 효과가 없는 상태였다.
//
// 경계는 **'혼잡' 하나만** 운영자가 옮긴다. 그 아래 보통/여유/한산 경계(0.5/0.25)는
// 그대로 둔다 — 이 값들은 색 범례·마커 색과 함께 쓰이는 표시 눈금이고, 운영자가 조정하는
// 대상('언제부터 분산 안내를 띄울 것인가')이 아니다.
//
// 경계가 0.5 보다 낮게 내려오면 '보통' 구간이 사라진다. 그건 결함이 아니라 의도다 —
// "60%부터 혼잡" 이라고 정했으면 62% 는 보통이 아니라 혼잡이어야 한다(혼잡 판정이 먼저다).

/** 운영자 설정을 못 받았을 때 쓰는 '혼잡' 경계. 백엔드 _congestion_label 임계값과 같다. */
export const DEFAULT_BUSY_THRESHOLD = 0.75;

export type CongestionKey = 'busy' | 'moderate' | 'relaxed' | 'quiet';

/** 관리자 설정값(0~100 정수) → 0..1 경계. 못 받았거나 값이 이상하면 기본값.
 *
 * 조회 실패·필드 부재·범위 밖 값은 전부 기본값으로 떨어뜨린다. 설정을 못 읽은 것을
 * '경계 0' 처럼 취급하면 모든 장소가 혼잡으로 보이고, 그건 없는 사실을 만드는 것이다. */
export function normalizeBusyThreshold(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_BUSY_THRESHOLD;
  if (raw < 0 || raw > 100) return DEFAULT_BUSY_THRESHOLD;
  return raw / 100;
}

/** 혼잡도(0..1) → 등급 키. 라벨은 호출부가 `congestion.{key}` 로 번역한다. */
export function congestionKey(level: number, busyAt: number = DEFAULT_BUSY_THRESHOLD): CongestionKey {
  if (level >= busyAt) return 'busy';
  if (level >= 0.5) return 'moderate';
  if (level >= 0.25) return 'relaxed';
  return 'quiet';
}
