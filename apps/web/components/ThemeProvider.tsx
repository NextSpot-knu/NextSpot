'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import {
  THEME_STORAGE_KEY,
  parseThemeMode,
  resolveTheme,
  supportsTouristTheme,
  type ResolvedTheme,
  type ThemeMode,
} from '@/lib/theme';

type ThemeContextValue = {
  mode: ThemeMode;
  resolvedTheme: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function applyTheme(theme: ResolvedTheme, enabled: boolean) {
  const root = document.documentElement;
  const dark = enabled && theme === 'dark';
  root.classList.toggle('nextspot-dark', dark);
  root.dataset.nextspotTheme = enabled ? theme : 'system';

  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta && enabled) meta.content = dark ? '#17130f' : '#faf5ec';
}

export default function ThemeProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [mode, setModeState] = useState<ThemeMode>('auto');
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>('light');

  const refresh = useCallback((nextMode: ThemeMode) => {
    const next = resolveTheme(nextMode);
    setResolvedTheme(next);
    applyTheme(next, supportsTouristTheme(pathname));
  }, [pathname]);

  useEffect(() => {
    let saved: ThemeMode = 'auto';
    try {
      saved = parseThemeMode(localStorage.getItem(THEME_STORAGE_KEY));
    } catch {
      /* 저장소가 차단되어도 자동 테마는 계속 동작한다. */
    }
    // 부트스트랩 스크립트가 DOM 테마는 이미 적용했다. React 상태 동기화는 다음 프레임에
    // 수행해 하이드레이션 직후의 연쇄 렌더를 피한다.
    const frame = window.requestAnimationFrame(() => {
      setModeState(saved);
      refresh(saved);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [refresh]);

  useEffect(() => {
    if (mode !== 'auto') return;
    const timer = window.setInterval(() => refresh('auto'), 60_000);
    return () => window.clearInterval(timer);
  }, [mode, refresh]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* 저장 실패 시 현재 탭에는 그대로 적용한다. */
    }
    refresh(next);
  }, [refresh]);

  const value = useMemo(() => ({ mode, resolvedTheme, setMode }), [mode, resolvedTheme, setMode]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used within <ThemeProvider>');
  return value;
}
