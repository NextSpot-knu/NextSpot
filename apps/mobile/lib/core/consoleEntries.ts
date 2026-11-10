// 콘솔 입구(사장님 콘솔 · 관제 대시보드) — 탭 막대 안내 줄 오른쪽 링크(D7 ①, docs/MOBILE_WEB_PARITY.md §3.2).
//
// 웹 원본: apps/web/components/shell/BottomNav.tsx:62-66·159-178, 목적지 규칙은 웹 순수 모듈 `@/lib/consoleLinks` 그대로
// (역할이 있으면 실제 콘솔, 없으면 로그인 없이 보는 데모 ?demo=1). 앱은 콘솔을 그리지 않고 운영 웹을 외부 브라우저로 연다.
// 앱 심사에서 '사업자 링크'가 문제 되면 SHOW_CONSOLE_ENTRIES 하나를 false 로 — 안내 줄에 '서비스 소개'만 남는다(D7 ②).
import type { Account } from '@/lib/accountRoles';
import { consoleLinks } from '@/lib/consoleLinks';

import { WEB_ORIGIN } from '../platform/shareUrls';

/** 탭 막대 안내 줄에 콘솔 링크 둘을 보일지(D7). */
export const SHOW_CONSOLE_ENTRIES = true;

export type ConsoleEntryUrls = { merchant: string; admin: string };

/** 계정 역할에 맞는 두 콘솔의 웹 주소(외부 브라우저로 연다). 계정을 아직 모르면 데모. */
export function consoleEntryUrls(account: Account | null, origin: string = WEB_ORIGIN): ConsoleEntryUrls {
  const links = consoleLinks(account);
  return { merchant: `${origin}${links.merchant}`, admin: `${origin}${links.admin}` };
}
