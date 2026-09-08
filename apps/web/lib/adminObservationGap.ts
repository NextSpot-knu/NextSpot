// '최근 N일 관측이 없다' 를 **사실로** 말하기 위한 문구 판정.
//
// 왜 필요한가: 관리자 리포트는 congestion_logs 를 최근 14일만 읽는다. 프로덕션에서 이 창은
// 지금 0행이다 — 조회는 200 으로 성공했고 마지막 관측이 그보다 오래됐을 뿐이다
// (2026-09-08 확인: 최신 행 2026-08-20T17:05Z = KST 8월 21일 02:05).
//
// 그런데 화면은 '표시할 방문량 데이터가 아직 없습니다' 라고만 말했다. 관리자가 이걸 읽으면
// 두 가지 중 무엇인지 알 수 없다:
//   · 관측이 원래 없는 서비스인가 (→ 할 일 없음)
//   · 수집이 19일째 멈춰 있는가   (→ 지금 당장 확인해야 함)
// 후자를 전자로 읽게 만드는 화면은 장애를 숨긴다. 그래서 **마지막 관측 시각을 조회해서**
// 함께 말한다. 지어내지 않는다 — 못 읽었으면 못 읽었다고 한다.
//
// 판정을 렌더에서 뗀 이유는 lib/adminLoadState.ts 머리말과 같다(렌더 테스트 러너 없음).

/**
 * 마지막 관측 조회 결과.
 *
 * `unknown` 이 따로 있는 이유: 마지막 관측 조회 **자체가 실패한 것**과 '관측 기록이 하나도
 * 없다' 는 완전히 다른 사실이다. 둘을 합치면 조회 장애가 '데이터 없음' 으로 보인다 —
 * 이 화면이 반복해서 저지른 바로 그 오류다.
 */
export type LastObservation =
  | { status: 'unknown' }
  | { status: 'none' }
  | { status: 'at'; iso: string };

/** 이 저장소는 시각을 KST 로 읽는다(리포트의 요일 버킷도 동일). 오프셋 고정 — 한국은 DST 없음. */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC 기준 시각을 KST 달력 날짜 라벨로. Intl 로케일에 기대지 않아 환경 간 결과가 같다. */
function kstDateLabel(ms: number): string {
  const d = new Date(ms + KST_OFFSET_MS);
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일`;
}

/**
 * 조회 창이 비었을 때 빈 자리에 넣을 문장.
 *
 * 문장이 '없습니다' 로 **끝나지 않게** 만드는 게 요점이다 — 뒤에 사실(마지막 관측 시각)이
 * 붙어야 관리자가 '수집이 멈췄다' 를 스스로 판단할 수 있다.
 */
export function describeObservationGap(
  last: LastObservation,
  windowDays: number,
  now: number,
): string {
  const head = `최근 ${windowDays}일 현장 관측이 없습니다`;

  if (last.status === 'unknown') {
    // 마지막 관측 조회까지 실패 — '기록이 없다' 고 단정하지 않는다.
    return `${head} — 마지막 관측이 언제였는지는 확인하지 못했습니다.`;
  }
  if (last.status === 'none') {
    return `${head} — 이전 관측 기록도 없습니다(수집이 아직 시작되지 않았습니다).`;
  }

  const observedMs = new Date(last.iso).getTime();
  if (!Number.isFinite(observedMs)) {
    // 값은 받았는데 시각으로 못 읽었다. 조용히 '없음' 으로 떨어뜨리면 또 사실이 뭉개진다.
    return `${head} — 마지막 관측 시각을 읽지 못했습니다(${last.iso}).`;
  }

  const elapsedDays = Math.floor((now - observedMs) / DAY_MS);
  const label = kstDateLabel(observedMs);
  if (elapsedDays < 0) {
    // 미래 시각. 시계가 어긋났거나 데이터가 이상하다 — 'N일 전' 을 지어내지 않는다.
    return `${head} — 마지막 관측이 미래 시각(${label})으로 기록돼 있습니다.`;
  }
  if (elapsedDays === 0) {
    return `${head} — 마지막 관측은 오늘(${label})입니다.`;
  }
  return `${head} — 마지막 관측은 ${label}, ${elapsedDays}일 전입니다.`;
}
