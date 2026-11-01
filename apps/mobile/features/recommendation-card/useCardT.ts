// 카드 문구 조회 — 앱 문구(t)에 아직 합쳐지지 않은 새 키를 요청 파일(i18n-requests/recommendation-card.json)에서 대신 읽는다.
//
// 문구 JSON 은 통합 때 한 번에 4로케일로 쓰는 규칙이라(apps/mobile/AGENTS.md) 이 기능은 새 키를 요청 파일에 적는다. 통합 전에도 화면이
// 키 이름을 그리지 않도록, t() 가 키를 못 찾았을 때만 요청 파일의 현재 언어 문구를 쓴다. 통합 뒤 같은 키가 JSON 에 생기면 JSON 이 먼저다.
import { useMemo } from 'react';

import type { Locale } from '@/lib/i18n/config';
import { useI18n } from '~/lib/i18n/I18nProvider';
import type { TFunc } from '~/lib/i18n/translate';

import { withRequestFallback } from './requestFallback';

export function useCardT(): { t: TFunc; locale: Locale } {
  const { t, locale } = useI18n();
  return useMemo(() => ({ t: withRequestFallback(t, locale), locale }), [t, locale]);
}
