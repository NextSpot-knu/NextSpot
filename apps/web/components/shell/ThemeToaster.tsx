'use client';

import { usePathname } from 'next/navigation';
import { Toaster } from 'sonner';
import { useTheme } from './ThemeProvider';

// 데스크톱 /main 의 화면 아래 가운데에는 '🔮 혼잡 예측' 줄(범례·칩 한 줄 포함 높이 ~110px)이 있다 — 그 위에 알림이 뜨면
// '다른 시간 ▾' 같은 줄의 버튼을 가린다(리뷰 10-07: '관광정보를 최신으로 불러왔어요' 가 줄 오른쪽을 덮었다). 그 화면에서만
// 알림을 줄 위로 올린다. 휴대폰(≤600px)은 sonner 의 휴대폰 여백(mobileOffset)을 그대로 쓴다.
const MAIN_DESKTOP_TOAST_BOTTOM_PX = 140;

export default function ThemeToaster() {
  const { resolvedTheme } = useTheme();
  const pathname = usePathname();
  const onMain = pathname === '/main' || pathname?.startsWith('/main/');
  return (
    <Toaster
      position="bottom-center"
      theme={resolvedTheme}
      richColors
      offset={onMain ? { bottom: MAIN_DESKTOP_TOAST_BOTTOM_PX } : undefined}
      toastOptions={{
        style: {
          background: 'var(--nextspot-hanji)',
          border: '1px solid var(--nextspot-line)',
          color: 'var(--nextspot-muk)',
        },
        className: 'backdrop-blur-md',
      }}
    />
  );
}
