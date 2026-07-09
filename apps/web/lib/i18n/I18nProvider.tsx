'use client';

// 클라이언트 i18n 컨텍스트 — 정적 export 앱이라 서버 로케일 라우팅 없이 동작한다.
// locale 은 localStorage('nextspot_locale')에 저장, 기본 ko. 하이드레이션 불일치를 피하려
// 서버/최초 렌더는 항상 DEFAULT_LOCALE 로 그리고, 마운트 후 저장된 로케일로 스왑한다(비-ko 사용자는
// 최초 1회 텍스트가 바뀜 — 정적 export 의 일반적 트레이드오프).

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { dictionaries, DEFAULT_LOCALE, type Locale, type Messages } from './dictionaries';

const STORAGE_KEY = 'nextspot_locale';

type TFunc = (key: string, vars?: Record<string, string | number>) => string;
type I18nContextValue = { locale: Locale; setLocale: (l: Locale) => void; t: TFunc };

const I18nContext = createContext<I18nContextValue | null>(null);

function lookup(dict: Messages, key: string): string | undefined {
  const val = key.split('.').reduce<string | Messages | undefined>(
    (o, k) => (o && typeof o === 'object' ? (o as Messages)[k] : undefined),
    dict,
  );
  return typeof val === 'string' ? val : undefined;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  // 마운트 후에만 localStorage 평가(SSR/프리렌더 하이드레이션 불일치 방지).
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && saved in dictionaries) {
        setLocaleState(saved as Locale);
        document.documentElement.lang = saved;
      }
    } catch {
      /* localStorage 차단 환경 — 기본 로케일 유지 */
    }
  }, []);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
      document.documentElement.lang = l;
    } catch {
      /* 무시 */
    }
  }, []);

  const t = useCallback<TFunc>(
    (key, vars) => {
      // 현재 로케일 → DEFAULT_LOCALE(ko) → 키 자체 순으로 폴백.
      const raw = lookup(dictionaries[locale], key) ?? lookup(dictionaries[DEFAULT_LOCALE], key) ?? key;
      if (!vars) return raw;
      return raw.replace(/\{(\w+)\}/g, (_, k: string) => (vars[k] != null ? String(vars[k]) : `{${k}}`));
    },
    [locale],
  );

  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within <I18nProvider>');
  return ctx;
}

/** 문자열 조회 훅 — const t = useT(); t('nav.home'). */
export function useT(): TFunc {
  return useI18n().t;
}
