/**
 * 마이페이지 하위 화면의 '뒤로' 목적지.
 *
 * router.back() 을 쓰면 안 된다. 정적 export 라 모든 경로가 진짜 HTML 페이지여서, 링크로
 * 바로 들어오거나 새로고침하면 히스토리에 앞 항목이 없다 — 그때 back() 은 **아무 일도 하지
 * 않아 버튼이 죽는다.** 반대로 다른 사이트를 거쳐 왔다면 앱 밖으로 나가 버린다.
 *
 * window.history.length 로 구분하려는 시도는 무력하다: 앱 진입 이전의 탭 이력까지 세기
 * 때문이다. 사장님 콘솔 나가기가 정확히 그 방식으로 실패했다(app/merchant/page.tsx 의 leave).
 *
 * 그래서 목적지를 못박는다. 이 화면들은 모두 마이페이지에서만 들어오므로 한 단계 위가 자명하다.
 */
export const MYPAGE_BACK = '/mypage';

export interface NavigationFacility { name: string; latitude: number; longitude: number }

export function openWalkingDirections(facility: NavigationFacility): void {
  const query = encodeURIComponent(facility.name);
  // Kakao does not provide a stable walking deep-link across all environments.
  // Open the destination page and let the user explicitly select walking.
  const url = `https://map.kakao.com/link/map/${query},${facility.latitude},${facility.longitude}`;
  const opened = window.open(url, '_blank', 'noopener,noreferrer');
  if (!opened) window.location.href = url;
}

export function openDrivingDirections(facility: NavigationFacility): void {
  const url = `https://map.kakao.com/link/to/${encodeURIComponent(facility.name)},${facility.latitude},${facility.longitude}`;
  const opened = window.open(url, '_blank', 'noopener,noreferrer');
  if (!opened) window.location.href = url;
}
