// 앱 i18n 컨텍스트 — 웹 apps/web/lib/i18n/I18nProvider.tsx 의 앱판(기준 커밋 e07ea61).
//
// 웹과 같은 것: 문구 JSON·사이드 사전·조회 순서·`{var}` 치환(translate.ts), 저장 키 nextspot_locale,
// 기기 언어 규칙(pickBrowserLocale), 직접 고른 언어만 저장.
// 다른 것:
//   - 하이드레이션이 없어 첫 렌더부터 저장된/기기 언어로 그린다(웹은 ko 로 그린 뒤 마운트 후 바꾼다).
//   - 기기 언어는 navigator.languages 대신 expo-localization getLocales() 의 languageTag(선호 순).
//   - en·ja·zh 사전은 동기 require 라 언어 바꾸기에 경합이 없다(웹의 requestRef 가 필요 없다).
//   - 관제·사장님·개발자 콘솔 경로 예외가 없다 — 앱은 관광객 화면만 있다.
//   - document.documentElement.lang 대신 localeState(이용 기록의 locale 칸이 읽는다).
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { getLocales } from 'expo-localization';
import type { Locale } from '@/lib/i18n/config';
import { ensureMessages } from './catalog';
import { LOCALE_STORAGE_KEY, pickInitialLocale } from './initialLocale';
import { setCurrentLocale } from './localeState';
import { createTranslator, type TFunc } from './translate';

export type { TFunc, TranslateVars } from './translate';
export { countKey } from '@/lib/i18n/count';

type I18nContextValue = { locale: Locale; setLocale: (l: Locale) => void; t: TFunc };

const I18nContext = createContext<I18nContextValue | null>(null);

function readSavedLocale(): string | null {
  try {
    return globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY) ?? null;
  } catch {
    return null; // 저장소를 못 읽으면 기기 언어를 따른다
  }
}

function deviceLanguageTags(): string[] {
  try {
    return getLocales().map((l) => l.languageTag);
  } catch {
    return [];
  }
}

function initialLocale(): Locale {
  const locale = pickInitialLocale(readSavedLocale(), deviceLanguageTags());
  ensureMessages(locale);
  setCurrentLocale(locale);
  return locale;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  useEffect(() => {
    setCurrentLocale(locale);
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    ensureMessages(next);
    // 렌더 전에 먼저 — useEffect 로만 알리면 언어를 바꾼 첫 렌더가 이전 언어의 한국어 낱말 단위 줄바꿈 설정으로 그려진다.
    setCurrentLocale(next);
    setLocaleState(next);
    try {
      globalThis.localStorage?.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      /* 저장 실패 — 이번 실행 동안만 바뀐다 */
    }
  }, []);

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t: createTranslator(locale, ensureMessages(locale)) }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
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

/** 지금 언어와 바꾸기 함수 — const [locale, setLocale] = useLocale(). */
export function useLocale(): [Locale, (l: Locale) => void] {
  const { locale, setLocale } = useI18n();
  return [locale, setLocale];
}
