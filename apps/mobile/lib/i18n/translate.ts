// 문구 조회·치환 — 웹 apps/web/lib/i18n/I18nProvider.tsx 의 t() 와 같은 순서·같은 치환(기준 커밋 e07ea61).
// React·RN 을 import 하지 않는 순수 모듈이라 node 테스트로 순서를 잠근다(translate.test.ts).
//
// 조회 순서(웹과 같다):
//   현재 로케일 사이드 사전(discovery → area-demand → theme) → 현재 로케일 JSON
//   → ko 사이드 사전(같은 순서) → ko JSON → 키 자체
// 현재 로케일 JSON 이 아직 없으면 ko JSON 으로 대신한다(웹의 `messagesRef.current[locale] ?? ko`).
import type { Locale, Messages } from '@/lib/i18n/config';
import { DEFAULT_LOCALE } from '@/lib/i18n/config';
import { AREA_DEMAND_MESSAGES } from '@/lib/i18n/area-demand-messages';
import { DISCOVERY_MESSAGES } from '@/lib/i18n/discovery-messages';
import { THEME_MESSAGES } from '@/lib/i18n/theme-messages';

export type TranslateVars = Record<string, string | number>;
export type TFunc = (key: string, vars?: TranslateVars) => string;
export type MessageTable = Partial<Record<Locale, Messages>>;

/** 점으로 나눈 키를 중첩 사전에서 찾는다. 문자열이 아니면(절·없음) undefined. */
export function lookup(dict: Messages | undefined, key: string): string | undefined {
  if (!dict) return undefined;
  const val = key.split('.').reduce<string | Messages | undefined>(
    (o, k) => (o && typeof o === 'object' ? (o as Messages)[k] : undefined),
    dict,
  );
  return typeof val === 'string' ? val : undefined;
}

/** `{name}` 자리 채우기. 값이 없는(null·undefined) 자리는 `{name}` 그대로 둔다(웹과 같다). */
export function interpolate(raw: string, vars?: TranslateVars): string {
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, k: string) => (vars[k] != null ? String(vars[k]) : `{${k}}`));
}

export function resolveMessage(locale: Locale, messages: MessageTable, key: string): string {
  const ko = messages[DEFAULT_LOCALE];
  const current = messages[locale] ?? ko;
  return DISCOVERY_MESSAGES[locale][key]
    ?? AREA_DEMAND_MESSAGES[locale][key]
    ?? THEME_MESSAGES[locale][key]
    ?? lookup(current, key)
    ?? DISCOVERY_MESSAGES[DEFAULT_LOCALE][key]
    ?? AREA_DEMAND_MESSAGES[DEFAULT_LOCALE][key]
    ?? THEME_MESSAGES[DEFAULT_LOCALE][key]
    ?? lookup(ko, key)
    ?? key;
}

/** 로케일·사전 묶음으로 t() 를 만든다. 사전 묶음은 호출 시점에 읽는다(늦게 실린 로케일도 반영). */
export function createTranslator(locale: Locale, messages: MessageTable): TFunc {
  return (key, vars) => interpolate(resolveMessage(locale, messages, key), vars);
}
