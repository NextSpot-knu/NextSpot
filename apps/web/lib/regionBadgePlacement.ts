// 떠 있는 내부 지역 배지(components/shell/RegionBadge)를 어느 화면에 그리나.
//
// 배지는 화면 위쪽 가운데에 고정된다. /main 은 그 줄에 언어 · 지역 스위처 알약이 서 있어(휴대폰 390px 에서 배지가
// 스위처 폭을 거의 다 덮는다) 배지를 그리지 않는다 — 그 화면에서는 스위처 자체가 내부 지역임을 표시한다
// (components/RegionSwitcher 의 실험 아이콘 · 이름). 경로를 모르면(첫 렌더) 그린다.

const ROUTES_WITH_TOP_SWITCHER: readonly string[] = ['/main'];

function normalize(pathname: string): string {
  const trimmed = pathname.replace(/\/index\.html$/, '').replace(/\/+$/, '');
  return trimmed || '/';
}

export function showsFloatingRegionBadge(pathname: string | null | undefined): boolean {
  if (!pathname) return true;
  return !ROUTES_WITH_TOP_SWITCHER.includes(normalize(pathname));
}
