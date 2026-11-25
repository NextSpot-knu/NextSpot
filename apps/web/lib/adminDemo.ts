// 관제 데모(`/admin/*?demo=1`) 공용 판정 — 로그인 없이 여는 읽기 전용 관제 화면들의 단일 출처.
//
// 왜: 처음 데모는 대시보드 한 화면뿐이라, 데모 사이드바의 다른 메뉴(통계 리포트 · SPOT 시뮬레이터 …)는
// 눌러도 '저장되지 않아요' 토스트만 떴다 — 둘러보는 사람에게는 관제 화면 대부분이 안 열리는 것으로 읽혔다
// (PM 2026-11-25). 이제 아래 집합의 화면은 각자 고정값(lib/demo/*)으로 데모를 그린다.
//
// 규칙(lib/demoFixtures.ts 머리말과 같다):
//   1. 이 집합에 넣는 화면은 데모 분기를 **반드시** 갖는다 — 넣기만 하면 세션 없이 실화면이 그려진다.
//   2. 데모는 관리자 API 를 부르지 않는다. 화면이 분기를 빠뜨려도 lib/admin-api.ts 가 요청을 보내기 전에
//      거절한다(isAdminDemoActive) — 데모에서 실 DB 로 가는 쓰기는 경로가 없다.
//   3. 쓰기 버튼은 눌리되 토스트(useDemoToast)만 띄운다.

import { createContext, useContext } from 'react';

/** 데모로 열 수 있는 관제 화면. 사이드바는 이 화면들로만 이동하고, 나머지는 토스트를 띄운다. */
export const ADMIN_DEMO_PATHS: ReadonlySet<string> = new Set([
  '/admin/dashboard',
  '/admin/infrastructure',
  '/admin/simulator',
  '/admin/reports',
  '/admin/safety',
  '/admin/report',
  '/admin/support',
  '/admin/settings',
]);

/** 이 경로가 데모로 열리는 관제 화면인가. `/admin`(인덱스)은 대시보드로 보내는 리다이렉트라 함께 통과한다. */
export function isAdminDemoPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return path === '/admin' || ADMIN_DEMO_PATHS.has(path);
}

/** 데모를 유지한 채 다른 관제 화면으로 가는 주소. */
export function adminDemoHref(path: string): string {
  return `${path}?demo=1`;
}

/** 관제 레이아웃(app/admin/layout.tsx)이 내려 주는 데모 판정. */
export const AdminDemoContext = createContext(false);

/** 지금 화면이 관제 데모인가. */
export function useAdminDemo(): boolean {
  return useContext(AdminDemoContext);
}

// 관리자 API 의 안전망 — 레이아웃이 렌더 중에 켜고 끈다(자식의 첫 이펙트보다 먼저 켜져야 하므로 이펙트가 아니다).
let demoActive = false;

export function setAdminDemoActive(on: boolean): void {
  demoActive = on;
}

export function isAdminDemoActive(): boolean {
  return demoActive;
}
