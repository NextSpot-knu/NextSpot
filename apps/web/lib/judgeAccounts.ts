// 공모전 심사용 테스트 계정 안내.
//
// 주최 측 제출 양식은 테스트 계정을 **하나만** 적게 돼 있는데(`openapi@메일도메인`), 이 서비스는
// 권한이 갈린 콘솔이 둘이라 계정도 둘이다. 폼에 못 적은 쪽 콘솔은 심사위원이 들어올 방법이 없으므로,
// 로그인 화면과 콘솔 관문에서 "이 콘솔은 이 계정"을 바로 알려준다.
//
// 계정 이메일의 정본은 `apps/api/scripts/seed_judge_accounts.py`(MERCHANT_EMAIL · ADMIN_EMAIL)다.
// 옆의 judgeAccounts.test.ts 가 두 파일이 어긋나면 실패한다 — 역할이 뒤바뀐 안내는
// 심사위원을 '권한 없음' 화면으로 보낸다.
//
// 비밀번호는 여기에도 화면에도 두지 않는다. 주최 측이 정한 값이라 심사위원은 이미 알고 있고,
// 정적 번들에 박으면 누구나 관리자 콘솔을 열 수 있다.

export type JudgeConsole = 'merchant' | 'admin';

export const JUDGE_ACCOUNTS: Record<JudgeConsole, string> = {
  merchant: 'openapi@naver.com',
  admin: 'openapi@gmail.com',
};

/**
 * `/login?next=` 목적지가 어느 콘솔인지 본다. 콘솔이 아니면 null.
 *
 * 접두사만 비교하면 `/administrator` 같은 경로가 관제로 잡히므로 경계(`/` · `?` · `#` · 끝)까지 확인한다.
 */
export function judgeConsoleForNext(next: string | null | undefined): JudgeConsole | null {
  if (!next) return null;
  const path = next.split(/[?#]/, 1)[0];
  if (path === '/admin' || path.startsWith('/admin/')) return 'admin';
  if (path === '/merchant' || path.startsWith('/merchant/')) return 'merchant';
  return null;
}
