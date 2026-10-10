'use client';

// 클라이언트 i18n 컨텍스트 — 정적 export 앱이라 서버 로케일 라우팅 없이 동작한다.
// locale 은 localStorage('nextspot_locale')에 저장, 기본 ko. 하이드레이션 불일치를 피하려
// 서버/최초 렌더는 항상 DEFAULT_LOCALE 로 그리고, 마운트 후 저장된 로케일로 스왑한다(비-ko 사용자는
// 최초 1회 텍스트가 바뀜 — 정적 export 의 일반적 트레이드오프). 저장된 언어가 없으면 관광객 화면은 기기 언어를
// 따른다(lib/i18n/browserLocale.ts — 저장하지 않음). 관제·사장님·개발자 콘솔은 한국어 고정 문구가 섞여 있고 언어
// 선택이 없어 기기 언어를 보지 않는다.

import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import koMessages from './messages/ko.json';
import { DEFAULT_LOCALE, type Locale, type Messages } from './config';
import { pickBrowserLocale } from './browserLocale';
import { AREA_DEMAND_MESSAGES } from './area-demand-messages';
import { DISCOVERY_MESSAGES } from './discovery-messages';
import { THEME_MESSAGES } from './theme-messages';

const STORAGE_KEY = 'nextspot_locale';

type TFunc = (key: string, vars?: Record<string, string | number>) => string;
type I18nContextValue = { locale: Locale; setLocale: (l: Locale) => void; t: TFunc };

const I18nContext = createContext<I18nContextValue | null>(null);
const VALID_LOCALES = new Set<Locale>(['ko', 'en', 'ja', 'zh']);

// 한국어만 초기 번들에 포함한다. 나머지 사전은 사용자가 언어를 선택할 때 별도 청크로 로드한다.
const loaders: Record<Exclude<Locale, 'ko'>, () => Promise<Messages>> = {
  en: () => import('./messages/en.json').then((m) => m.default as Messages),
  ja: () => import('./messages/ja.json').then((m) => m.default as Messages),
  zh: () => import('./messages/zh.json').then((m) => m.default as Messages),
};

function lookup(dict: Messages, key: string): string | undefined {
  const val = key.split('.').reduce<string | Messages | undefined>(
    (o, k) => (o && typeof o === 'object' ? (o as Messages)[k] : undefined),
    dict,
  );
  return typeof val === 'string' ? val : undefined;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);
  const messagesRef = useRef<Partial<Record<Locale, Messages>>>({ ko: koMessages as Messages });
  const [, forceMessagesVersion] = useState(0);
  // 언어 바꾸기 요청마다 1씩 오른다 — 늦게 끝난 앞 요청(예: 기기 언어 불러오기)이 뒤에 고른 언어를 덮지 않게.
  const requestRef = useRef(0);

  const loadLocale = useCallback(async (next: Locale) => {
    if (messagesRef.current[next] || next === 'ko') return;
    const messages = await loaders[next as Exclude<Locale, 'ko'>]();
    messagesRef.current[next] = messages;
    forceMessagesVersion((v) => v + 1);
  }, []);

  // 마운트 후에만 localStorage 평가(SSR/프리렌더 하이드레이션 불일치 방지).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const saved = raw && VALID_LOCALES.has(raw as Locale) ? (raw as Locale) : null;
      // 고른 적이 없으면 기기 언어를 따른다(외국인 관광객이 한국어 첫 화면에서 언어 선택을 찾지 않게). 저장하지는
      // 않는다 — 사용자가 직접 고른 언어만 남긴다. 콘솔(관제·사장님·개발자)은 제외.
      const consolePath = /^\/(admin|merchant|dev)(\/|$)/.test(window.location.pathname);
      const chosen = saved ?? (consolePath ? null : pickBrowserLocale(navigator.languages?.length ? navigator.languages : [navigator.language]));
      if (chosen && chosen !== DEFAULT_LOCALE) {
        const next = chosen;
        const request = ++requestRef.current;
        void loadLocale(next).then(() => {
          if (request === requestRef.current) setLocaleState(next);
        });
        document.documentElement.lang = next;
      }
    } catch {
      /* localStorage 차단 환경 — 기본 로케일 유지 */
    }
  }, [loadLocale]);

  const setLocale = useCallback((l: Locale) => {
    const request = ++requestRef.current;
    void loadLocale(l).then(() => {
      if (request === requestRef.current) setLocaleState(l);
    });
    try {
      localStorage.setItem(STORAGE_KEY, l);
      document.documentElement.lang = l;
    } catch {
      /* 무시 */
    }
  }, [loadLocale]);

  const t = useCallback<TFunc>(
    (key, vars) => {
      // 현재 로케일 → DEFAULT_LOCALE(ko) → 키 자체 순으로 폴백.
      const current = messagesRef.current[locale] ?? messagesRef.current[DEFAULT_LOCALE]!;
      const raw = DISCOVERY_MESSAGES[locale][key]
        ?? AREA_DEMAND_MESSAGES[locale][key]
        ?? THEME_MESSAGES[locale][key]
        ?? lookup(current, key)
        ?? DISCOVERY_MESSAGES[DEFAULT_LOCALE][key]
        ?? AREA_DEMAND_MESSAGES[DEFAULT_LOCALE][key]
        ?? THEME_MESSAGES[DEFAULT_LOCALE][key]
        ?? lookup(messagesRef.current[DEFAULT_LOCALE]!, key)
        ?? key;
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
