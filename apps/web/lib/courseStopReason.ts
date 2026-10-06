// 분산 코스 정류지의 '추천 이유' 를 화면 언어로 만들 때 쓰는 서버 신호(2026-10-06 감사 I58 후속).
//
// 서버(apps/api/app/routers/courses.py _build_stop_reason)는 한국어 문장 한 벌만 보낸다. 화면은 그 문장을 다른 언어로
// 보여 줄 수 없어 이유를 직접 만든다. 그런데 '도착할 때 지금보다 덜 붐빈다'(시간 분산 효과)는 이 정류지의 **지금** 혼잡을
// 알아야 하는데, 그 값은 응답에 실리지 않는다(서버 안에서만 쓴다). 그래서 서버가 그 판단을 문장에 넣었는지를 읽는다 —
// 서버는 지금 혼잡이 '지금' 자격이 있고 도착 시점 예측보다 0.1 이상 높을 때만 이 구절을 붙인다.
const CALMER_CLAUSE = /여유로워질 시간대/;

/** 서버가 '도착할 때 지금보다 덜 붐빈다' 고 판단한 정류지인가. */
export function stopCalmerOnArrival(serverReason: string | null | undefined): boolean {
  return typeof serverReason === 'string' && CALMER_CLAUSE.test(serverReason);
}
