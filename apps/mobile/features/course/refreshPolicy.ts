// 코스 탭에 돌아왔을 때 다시 짤지 — 순수 판정(테스트: refreshPolicy.test.ts).
// 대기 보드(features/waiting/useWaitingBoard 의 REFRESH_AFTER_MS)와 같은 태도: 이미 그려진 계획은 그대로 두고 조건이 바뀌었거나
// 마지막 성공이 오래됐을 때만 다시 묻는다. 여행 조건(nextspot_setup_prefs)은 첫 설정 다시 하기 등 다른 화면에서 바뀌는데
// 계획 요청의 deps 가 아니라서, 포커스 때 서명을 비교하지 않으면 낡은 조건의 코스가 계속 보였다.

/** 마지막 성공에서 이만큼 지나 탭에 돌아오면 조용히 다시 짠다(도착 시각·혼잡이 낡는다). */
export const COURSE_REFRESH_AFTER_MS = 10 * 60 * 1000;

export interface CourseFocusInput {
  /** 지금 저장된 여행 조건의 서명. */
  contextKey: string;
  /** 마지막으로 요청에 쓴 여행 조건의 서명(아직 요청 전이면 null). */
  requestedContextKey: string | null;
  /** 마지막 성공 시각(ms, 없으면 0). */
  lastOkAt: number;
  now: number;
  /** 요청이 진행 중인가 — 진행 중이면 겹쳐 보내지 않는다(조건이 바뀐 경우는 예외: 새 조건이 이긴다). */
  inFlight: boolean;
  /** 로그인이 필요해 멈춘 상태인가 — 로그인 이벤트가 따로 되살린다. */
  needsAuth: boolean;
}

export type CourseFocusDecision = 'replan' | 'skip';

export function decideCourseFocusRefresh(input: CourseFocusInput): CourseFocusDecision {
  if (input.requestedContextKey === null) return 'skip'; // 첫 요청은 마운트가 보낸다
  if (input.contextKey !== input.requestedContextKey) return 'replan';
  if (input.inFlight || input.needsAuth) return 'skip';
  if (input.lastOkAt > 0 && input.now - input.lastOkAt > COURSE_REFRESH_AFTER_MS) return 'replan';
  return 'skip';
}

/** 인증 이벤트 뒤 다시 짤지 — 로그인이 필요해 멈춘 화면만, 세션이 생긴 SIGNED_IN·TOKEN_REFRESHED 에서 되살린다. */
export function shouldRecoverOnAuthEvent(event: string, hasSession: boolean, needsAuth: boolean): boolean {
  return needsAuth && hasSession && (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED');
}
