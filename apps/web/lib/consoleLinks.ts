// 관광객 화면(왼쪽 레일 · 폰 하단 줄 · 마이페이지)의 '사장님 콘솔' · '관제 대시보드' 목적지.
//
// 왜 한 곳에 두나: 콘솔 입구가 여러 화면에 생기면서 "누가 어디로 가는가"가 갈라지기 쉬워졌다.
// 규칙은 하나다 — 그 콘솔에 들어갈 역할이 있으면 실제 콘솔, 없으면(게스트·관광객·다른 역할)
// 로그인 없이 볼 수 있는 읽기 전용 데모(?demo=1). 심사위원이 레일을 누르면 막힘 없이 화면이 열린다.
//
// 판정은 lib/accountRoles.ts 의 단일 출처를 그대로 쓴다(React·네트워크 없이 테스트된다).

import { canEnterAdminConsole, canEnterMerchantConsole, type Account } from './accountRoles';

export const MERCHANT_CONSOLE_PATH = '/merchant';
export const MERCHANT_DEMO_PATH = '/merchant?demo=1';
// `/admin` 이 아니라 `/admin/dashboard` 다 — `/admin` 은 정적 export 용 리다이렉트 껍데기다.
export const ADMIN_CONSOLE_PATH = '/admin/dashboard';
export const ADMIN_DEMO_PATH = '/admin/dashboard?demo=1';

export interface ConsoleLinks {
  merchant: string;
  admin: string;
}

/** 계정 역할에 맞는 두 콘솔의 목적지. 계정을 아직 모르면(null) 데모로 보낸다. */
export function consoleLinks(account: Account | null): ConsoleLinks {
  return {
    merchant: canEnterMerchantConsole(account) ? MERCHANT_CONSOLE_PATH : MERCHANT_DEMO_PATH,
    admin: canEnterAdminConsole(account) ? ADMIN_CONSOLE_PATH : ADMIN_DEMO_PATH,
  };
}
