// 첫 화면 언어 — 저장된 선택(웹과 같은 키 nextspot_locale)이 있으면 그것, 없으면 기기 언어.
// 기기 언어 규칙은 웹 pickBrowserLocale 을 그대로 쓴다(목록 어디든 한국어면 ko, 아니면 첫 언어로 ja·zh, 그 밖은 en).
// 기기 언어로 고른 값은 저장하지 않는다 — 사용자가 직접 고른 언어만 남긴다(웹과 같다).
import { pickBrowserLocale } from '@/lib/i18n/browserLocale';
import { DEFAULT_LOCALE, type Locale } from '@/lib/i18n/config';

export const LOCALE_STORAGE_KEY = 'nextspot_locale';
const VALID_LOCALES = new Set<Locale>(['ko', 'en', 'ja', 'zh']);

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && VALID_LOCALES.has(value as Locale);
}

/**
 * @param saved 저장소에서 읽은 값(없으면 null)
 * @param deviceTags 기기 언어 태그 목록(expo-localization getLocales() 의 languageTag, 선호 순)
 */
export function pickInitialLocale(saved: string | null | undefined, deviceTags: readonly string[] | null | undefined): Locale {
  if (isLocale(saved)) return saved;
  return pickBrowserLocale(deviceTags) ?? DEFAULT_LOCALE;
}
