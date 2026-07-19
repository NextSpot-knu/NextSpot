// 경량 제품 분석 이벤트 트래킹 클라이언트 — 백엔드 POST /api/v1/events/track
// (apps/api/app/routers/tracking.py, TrackRequest { event, props }) 으로 비동기 전송.
//
// 설계:
//   - navigator.sendBeacon 우선: 페이지 이탈/언마운트 중에도 브라우저가 전송을 보장한다.
//     미지원·큐잉 실패 시 fetch(keepalive:true) 로 폴백.
//   - 계측은 부가 기능 — 어떤 예외도 호출부(UI)로 전파하지 않는다(무해 무시). 응답도 기다리지 않는다.
//   - SSR/프리렌더 가드(typeof window) — 정적 export 빌드 중 실행되지 않게 한다.
//   - FASTAPI 베이스 URL 계산은 lib/api-client.ts 의 BASE_URL 과 동일 로직이다.
//     그 파일이 값을 export 하지 않아 여기 인라인 중복했다 — 값을 바꿀 땐 두 파일 다 함께 수정할 것.
const FASTAPI_BASE_URL = process.env.NEXT_PUBLIC_FASTAPI_URL || "http://localhost:8000";
const TRACK_URL = `${FASTAPI_BASE_URL}/api/v1/events/track`;

const EVENT_PROPS: Record<string, ReadonlySet<string>> = {
  context_applied: new Set(["categories", "max_walk_minutes", "available_minutes", "required_attributes", "exclude_visited"]),
  recommendation_compared: new Set(["count"]),
  recommendation_explained: new Set(["question", "llm_status"]),
  navigation_started: new Set(["facility_type", "navigation_mode", "walk_minutes"]),
  trip_resumed: new Set(["facility_type"]),
  replan_requested: new Set(["facility_type"]),
  arrival_confirmed: new Set(["facility_type"]),
  visit_confirmed: new Set(["facility_type", "rating"]),
};

/**
 * 익명 분석 이벤트 1건을 백엔드로 전송한다(fire-and-forget, 실패해도 UI 에 영향 없음).
 * @param event 이벤트명(백엔드 상한 64자 — 초과 시 백엔드가 422 로 거부, 여기서는 무시됨)
 * @param props 부가 속성(백엔드 상한 직렬화 1KB — 초과 시 백엔드가 422 로 거부, 여기서는 무시됨)
 */
export function track(event: string, props?: Record<string, unknown>): void {
  if (typeof window === "undefined") return; // SSR/프리렌더 가드

  try {
    const allowed = EVENT_PROPS[event];
    if (!allowed) return;
    const safeProps = Object.fromEntries(
      Object.entries(props ?? {}).filter(([key]) => allowed.has(key)),
    );
    const payload = JSON.stringify({ event, props: safeProps });

    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      const blob = new Blob([payload], { type: "application/json" });
      const queued = navigator.sendBeacon(TRACK_URL, blob);
      if (queued) return;
      // sendBeacon 이 큐잉 실패(false)를 반환한 경우에만 fetch 로 폴백.
    }

    fetch(TRACK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true,
    }).catch(() => {
      /* 계측 실패는 무해 무시 */
    });
  } catch {
    /* 계측은 부가 기능 — 어떤 예외도 UI 로 전파하지 않는다 */
  }
}
