// /explore/map — 옛 주소·북마크 호환. 웹 apps/web/app/explore/map/page.tsx 처럼 지도(홈)로 바꿔치기한다(G4a-31).
// 탭 안 숨은 경로라 expo-router <Redirect>(탭에서는 JUMP_TO)를 쓰지 않는다 — 이 경로가 탭 기록에 남으면 홈에서 뒤로 갈 때
// 여기로 돌아와 다시 홈으로 튕긴다. useLeaveHiddenTab 이 기록에서 이 경로를 빼고 홈으로 옮긴다. 첫 실행 게이트는 (tabs)/_layout 이 먼저 막는다.
import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';

import { useLeaveHiddenTab } from '~/components/navigation/useLeaveHiddenTab';

export default function ExploreMapRedirect() {
  const leave = useLeaveHiddenTab();
  useFocusEffect(
    useCallback(() => {
      leave('index');
    }, [leave]),
  );
  return null;
}
