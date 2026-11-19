// 코스 탭에 돌아왔을 때 다시 짤지 — 순수 판정(테스트: refreshPolicy.test.ts).
// 결정 D16(b): 웹은 탭을 오갈 때마다 /course 가 새로 마운트돼 계획을 다시 받는다(서버에 사용자별 180초 캐시가 있어 부하는 같다).
// 앱도 방문마다 조용히 다시 받는다 — 같은 조건이면 로더 없이 보이는 계획을 유지하고 실패해도 그대로 둔다(useCoursePlan 의 스테일-우선).
// 예전의 '조건이 바뀌었거나 10분이 지났을 때만' 간격은 거둔다.

export interface CourseFocusInput {
  /** 지금 저장된 여행 조건의 서명. */
  contextKey: string;
  /** 마지막으로 요청에 쓴 여행 조건의 서명(아직 요청 전이면 null). */
  requestedContextKey: string | null;
  /** 요청이 진행 중인가 — 진행 중이면 겹쳐 보내지 않는다(조건이 바뀐 경우는 예외: 새 조건이 이긴다). */
  inFlight: boolean;
}

export type CourseFocusDecision = 'replan' | 'skip';

export function decideCourseFocusRefresh(input: CourseFocusInput): CourseFocusDecision {
  if (input.requestedContextKey === null) return 'skip'; // 첫 요청은 마운트가 보낸다
  if (input.contextKey !== input.requestedContextKey) return 'replan';
  return input.inFlight ? 'skip' : 'replan';
}

/** 인증 이벤트 뒤 다시 짤지 — 로그인이 필요해 멈춘 화면만, 세션이 생긴 SIGNED_IN·TOKEN_REFRESHED 에서 되살린다. */
export function shouldRecoverOnAuthEvent(event: string, hasSession: boolean, needsAuth: boolean): boolean {
  return needsAuth && hasSession && (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED');
}
