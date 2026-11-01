// 문구 요청 파일 폴백(순수) — useCardT 가 쓴다. 키를 못 찾았을 때만 요청 파일의 현재 언어 문구를 읽는다.
import type { Locale } from '@/lib/i18n/config';
import { interpolate, type TFunc, type TranslateVars } from '~/lib/i18n/translate';

import requests from '../../i18n-requests/recommendation-card.json';

export type RequestEntry = Partial<Record<Locale, string>> & { ko: string };
export const REQUESTS = requests as Record<string, RequestEntry>;

export function withRequestFallback(base: TFunc, locale: Locale, table: Record<string, RequestEntry> = REQUESTS): TFunc {
  return (key: string, vars?: TranslateVars) => {
    const found = base(key, vars);
    if (found !== key) return found;
    const entry = table[key];
    if (!entry) return found;
    return interpolate(entry[locale] ?? entry.ko, vars);
  };
}
