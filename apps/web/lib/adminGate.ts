// 관제 콘솔(/admin/*) 진입 판정 — 순수 함수(렌더 없음). app/admin/layout.tsx 가 이 결과만 따른다.
//
// 왜 별도 모듈인가: 이 저장소에는 React 렌더 테스트 러너가 없다(lib/adminLoadState.ts 와 같은 이유).
// 여기서 한 칸 틀리면 로그인한 관리자가 로그인 화면으로 튕긴다 — 실제로 그랬다.
//
// 2026-09-26 01:21 KST 실측: 코스 계산 하나가 0.5 CPU 인스턴스를 23초 붙잡는 동안 /account/me 가
// 프런트 10초 타임아웃에 걸렸다. 서버는 12초 뒤 '관리자' 로 200 을 돌려줬지만, 그 사이 레이아웃이
// '확인 실패' 를 '권한 없음' 으로 읽어 /admin/login 으로 보냈다 → 재시도 성공 → 대시보드 복귀.
// 사용자에게는 '튕겼다가 재접속' 으로 보였다. 09-22 에는 인스턴스 재시작 2분 동안 같은 일이 났다.
//
// 원칙: **서버에 닿지 못한 실패는 권한 판정이 아니다.** 로그인 화면으로 보내는 것은 판정이 부정으로
// 끝났을 때(세션 없음 401, 또는 로그인했지만 역할이 모자람)뿐이다. 닿지 못했으면 콘솔을 그대로 두거나
// (직전에 관리자로 확인된 브라우저) '서버 연결 확인 · 다시 시도' 를 보여 주고, AccountProvider 의
// 자동 재시도(2.5s → 5s → 8s)와 '다시 시도' 버튼이 판정을 끝내게 둔다.
//
// 보안은 약해지지 않는다: 이 가드는 UX 일 뿐이고, 관리자 데이터는 전부 관리자 API 뒤에서 서버가 매
// 요청 역할을 확인한다(app/core/authz.py). 닿지 못한 동안 콘솔이 보여도 데이터 호출은 똑같이 막힌다.

/** AccountProvider 가 주는 판정 상태(lib/account.tsx). */
export type AccountGateStatus = 'loading' | 'ready' | 'error';

export interface AdminGateInput {
  /** 마운트 뒤인가(localStorage·location 은 마운트 뒤에만 읽는다). */
  mounted: boolean;
  status: AccountGateStatus;
  /** 마지막 계정 조회가 서버에 닿지 못해(타임아웃·5xx·네트워크) 실패했는가. */
  unreachable: boolean;
  /** 지금 알고 있는 계정이 관제 콘솔에 들어갈 수 있는가(canEnterAdminConsole). */
  allowed: boolean;
  isLoginRoute: boolean;
  /** 읽기 전용 데모(?demo=1, 대시보드 한 화면). */
  demo: boolean;
  /** 이 브라우저가 최근(7일) 관리자로 확인된 적이 있는가(게이트 캐시). */
  optimisticAllowed: boolean;
}

export type AdminGateView = 'console' | 'loader' | 'server-unreachable';

export interface AdminGateDecision {
  view: AdminGateView;
  /** 로그인 화면으로 보낼 것인가 — 판정이 **부정으로 끝났을 때만** 참. */
  redirectToLogin: boolean;
  /** 게이트 캐시 처리: 긍정이면 저장, 부정으로 끝났을 때만 지운다(닿지 못함은 그대로 둔다). */
  cache: 'save' | 'clear' | 'keep';
}

export function decideAdminGate(input: AdminGateInput): AdminGateDecision {
  const resolved = input.mounted && input.status !== 'loading';
  const authed = resolved && input.allowed;
  // 판정이 '부정으로 끝남' — 서버가 답했고(401 이거나 역할 부족) 그 답이 '아니오' 다.
  const denied = resolved && !input.allowed && !input.unreachable;

  const redirectToLogin = denied && !input.isLoginRoute && !input.demo;

  let cache: AdminGateDecision['cache'] = 'keep';
  if (!input.demo) {
    if (authed) cache = 'save';
    else if (denied) cache = 'clear';
  }

  let view: AdminGateView;
  if (input.isLoginRoute || input.demo || authed) view = 'console';
  else if (input.optimisticAllowed && !denied) view = 'console';
  else if (resolved && input.unreachable) view = 'server-unreachable';
  else view = 'loader';

  return { view, redirectToLogin, cache };
}
