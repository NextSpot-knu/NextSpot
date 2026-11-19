// 하단 탭 막대 치수 훅 — 계산은 navMetricsCore.ts(docs/MOBILE_WEB_PARITY.md §4.2 F1).
// 화면 코드에 15·24·101·116 을 직접 쓰지 않는다 — 여기 export 와 tokens 의 NAV_BAR_HEIGHT·NAV_CLEARANCE 만 쓴다.
import { usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { navInsetsFor, type NavInsets } from './navMetricsCore';

export { NAV_GAP, isTabRoute, navInsetsFor, type NavInsets } from './navMetricsCore';

export function useNavInsets(): NavInsets {
  const pathname = usePathname();
  const { bottom } = useSafeAreaInsets();
  return navInsetsFor(pathname, bottom);
}
