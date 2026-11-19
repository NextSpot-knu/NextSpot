// 지금 화면 언어 — 모듈 상태 한 칸. 훅이 아닌 함수(이용 기록의 locale 칸 등)가 읽는다.
// 웹은 document.documentElement.lang 을 읽는다(apps/web/lib/usageEvents.ts) — 앱에는 그 자리가 없어 여기 둔다.
// 쓰는 곳은 I18nProvider 하나뿐이다.
import { DEFAULT_LOCALE, type Locale } from '@/lib/i18n/config';

let currentLocale: Locale = DEFAULT_LOCALE;

export function getCurrentLocale(): Locale {
  return currentLocale;
}

export function setCurrentLocale(locale: Locale): void {
  currentLocale = locale;
}
