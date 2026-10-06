// 30일 추이를 '실측 계열' 로 그릴 수 있는가 — 대시보드 ③ 차트와 성과 리포트가 함께 쓰는 문턱(I73).
//
// 실측일이 한두 날뿐이면 추이로서 의미가 없다. 그런 날은 심사위원의 좌석 방송 한 번이나 관리자 수동 입력 한 번으로도
// 생긴다 — 그 하루 때문에 30일 추정 추이와 총평이 통째로 사라지면 안 된다. 3일부터 실측 추이로 넘어간다.

export const MIN_MEASURED_TREND_DAYS = 3;

/** 실측 표본이 있는 날 수가 문턱을 넘었는가(숫자가 아니면 아니다). */
export function hasMeasuredTrend(measuredDays: number | null | undefined): boolean {
  return typeof measuredDays === 'number' && Number.isFinite(measuredDays) && measuredDays >= MIN_MEASURED_TREND_DAYS;
}
