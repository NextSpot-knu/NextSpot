// 조회 창(최근 N일)에 현장 관측이 아직 들어오지 않았을 때 빈 자리에 넣을 안내 문구.
//
// 내부 사정(마지막 관측 시각·경과일·조회 실패 여부)은 화면에 적지 않는다 — 이 화면을 보는
// 사람은 경북문화관광공사 담당자와 심사위원이고, 그들에게 필요한 것은 '지금 무엇이 보이고
// 다음에 무엇이 채워지는가' 다. 운영자가 필요한 원문 단서는 호출부의 console.warn 에 남는다.
//
// 판정을 렌더에서 뗀 이유는 lib/adminLoadState.ts 머리말과 같다(렌더 테스트 러너 없음).

/**
 * 마지막 관측 조회 결과.
 *
 * `unknown` 이 따로 있는 이유: 마지막 관측 조회 **자체가 실패한 것**과 '관측 기록이 하나도
 * 없다' 는 호출부에게 서로 다른 사실이다(로그·재시도 판단이 갈린다). 화면 문구는 둘을
 * 구분해 노출하지 않지만, 타입으로는 계속 구분해 둔다.
 */
export type LastObservation =
  | { status: 'unknown' }
  | { status: 'none' }
  | { status: 'at'; iso: string };

/**
 * 조회 창이 비었을 때 빈 자리에 넣을 문장.
 *
 * 창 길이는 호출부가 정한다(리포트 화면은 14일). 경과일·날짜·원문은 담지 않는다.
 */
export function describeObservationGap(
  _last: LastObservation,
  windowDays: number,
  _now: number,
): string {
  return `최근 ${windowDays}일 현장 관측은 다음 수집 주기에 반영됩니다 — 같은 기간 공영주차 실측 기반 추정 지표를 아래에 제공합니다.`;
}
