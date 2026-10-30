// GET /api/v1/impact/summary 응답 → 화면이 쓰는 숫자. /mypage 요약 카드 · 아낀 대기 배너 · /mypage/impact 가 같은 규칙을 쓴다
// (세 화면이 각자 읽으면 한 화면은 '0분' 을 말하고 다른 화면은 숨기는 식으로 갈라진다).
//
// 지키는 선(P0-5 b):
//   · 근거 없는 값은 0 으로 지어내지 않는다 — 도착 확인을 서버가 세지 못했으면(조회 실패 · 구 서버) null 이다.
//   · 셀 수 없는 응답 모양은 0 이다(음수·NaN·문자열을 그대로 화면에 올리지 않는다).
//   · '기록이 있다' 는 실제로 센 출발·도착·쿠폰이 하나라도 있을 때뿐이다 — 그 밖에는 시작 상태를 보여 준다.

export interface ImpactSummary {
  /** 길안내로 출발한 횟수(같은 날 같은 곳은 한 번 — 서버가 묶는다). */
  accepted: number;
  /** 도착 확인 횟수. 서버가 세지 못했으면 null — 화면은 그 숫자를 그리지 않는다. */
  arrivalsConfirmed: number | null;
  /** 원래 장소보다 덜 붐빌 것으로 본 곳을 고른 횟수(근거가 있는 수락만). */
  congestionAvoided: number;
  couponsIssued: number;
  couponsUsed: number;
  /** 원래 장소와 고른 곳의 예상 대기 차이 합(분). 둘 다 예측이 있는 수락에서만 생긴다. */
  waitSavedMinutes: number;
  /** 보여 줄 실제 기록이 있는가 — 없으면 시작 상태(지도로 가는 버튼)다. */
  hasRecord: boolean;
}

function count(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

export function readImpactSummary(data: unknown): ImpactSummary {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const arrivalsRaw = d.arrivalsConfirmed;
  const arrivalsConfirmed = typeof arrivalsRaw === 'number' && Number.isFinite(arrivalsRaw)
    ? Math.max(0, Math.round(arrivalsRaw))
    : null;
  const accepted = count(d.accepted);
  const couponsIssued = count(d.couponsIssued);
  return {
    accepted,
    arrivalsConfirmed,
    congestionAvoided: count(d.congestionAvoided),
    couponsIssued,
    couponsUsed: count(d.couponsUsed),
    waitSavedMinutes: count(d.waitSavedMinutes),
    hasRecord: accepted > 0 || (arrivalsConfirmed ?? 0) > 0 || couponsIssued > 0,
  };
}
