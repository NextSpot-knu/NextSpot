// 유저 스코프 로컬 데이터 격리 — docs/OAUTH_PLAN.md 후속(사용자 데이터 분리).
//
// 저장 장소·취향·방문 이력·표시이름 등은 localStorage 에 있는데, localStorage 는 '기기' 단위라
// 로그아웃/계정 전환에도 남아 다음 사용자에게 샌다. 세션(user_id)이 바뀌면 이전 사용자의 개인
// 데이터를 지워 사용자 간 데이터를 확실히 분리한다.
//
// 원칙: '개인 데이터'만 지운다. 언어·지도뷰·PWA 스누즈·알림 옵트인 같은 '기기 UI 설정'과
//       admin/merchant 세션(별도 인증)은 건드리지 않는다.

// 세션 전환 시 삭제할 개인 데이터 키(명시적 allowlist — 새 키가 실수로 기기설정까지 날리지 않게).
const USER_SCOPED_KEYS = [
  'nextspot_saved_facilities',        // 저장한 장소
  'nextspot_setup_prefs',             // 온보딩 취향
  'nextspot_display_name',            // 표시 이름
  'nextspot_visit_history',           // 방문 이력
  'nextspot_visit_count',             // 방문 수
  'nextspot_visit_counted_session',   // 방문 카운트 세션 표식
  'nextspot_pending_visit',           // 방문 확인 대기
  'nextspot_rejected_ids',            // 거절한 추천(개인화)
  'nextspot_onboarding_done',         // 온보딩 완료 표식
  'nextspot_congestion_alerts_notified', // 혼잡 알림 발송 로그(사용자별 dedup)
] as const;

// 마지막으로 관측한 세션 user_id. 이 값과 현재 uid 를 비교해 전환을 감지한다(기기 UI 설정이라 유지 대상).
const LAST_UID_KEY = 'nextspot_last_uid';

/** 현재 사용자의 개인 데이터(localStorage)를 모두 지운다. 기기 UI 설정·admin/merchant 세션은 보존. */
export function clearUserScopedData(): void {
  try {
    for (const key of USER_SCOPED_KEYS) localStorage.removeItem(key);
  } catch {
    /* localStorage 차단 환경 — 무시 */
  }
}

/**
 * 현재 세션 user_id 를 직전과 비교해, 바뀌었으면 이전 사용자 개인 데이터를 청소한다.
 * - 로그아웃 → 새 익명 세션(uid 변경) → 청소
 * - 다른 계정으로 로그인(계정 전환, uid 변경) → 청소
 * - linkIdentity(익명 → 계정 승격)는 uid 가 그대로라 청소하지 않는다 → 같은 사람의 데이터 보존
 * SessionBootstrap 이 세션 확정 직후 매번 호출한다(멱등 — 같은 uid 면 아무 것도 안 함).
 */
export function reconcileUserData(currentUid: string | null): void {
  if (!currentUid) return; // 세션 없음(익명 로그인 비활성 등) → 판단 보류(다음 확정 때 처리).
  try {
    const last = localStorage.getItem(LAST_UID_KEY);
    if (last && last !== currentUid) clearUserScopedData();
    if (last !== currentUid) localStorage.setItem(LAST_UID_KEY, currentUid);
  } catch {
    /* localStorage 차단 환경 — 무시 */
  }
}
