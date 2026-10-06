// 음성(TTS · STT)의 언어 — 화면 언어를 따른다(계획 B5 · I21, PM 4.12a).
//
// 왜 필요한가: TTS 는 ko-KR 고정, STT 도 ko-KR 고정이라 en/ja/zh 화면에서 음성 비서는 한국어로만 말하고
// '응/다음' 만 알아들었다. 기능설명서는 '음성 안내까지 4개 언어' 라고 적고 있다.
//
// 정적 export(SSR) 안전: 이 파일은 순수 함수만 둔다(window 접근 없음).

import type { Locale } from '../i18n/config';

const SPEECH_LANG: Record<Locale, string> = { ko: 'ko-KR', en: 'en-US', ja: 'ja-JP', zh: 'zh-CN' };

/** 화면 언어 → Web Speech 의 BCP-47 언어 태그. 모르는 값이면 ko-KR(예전 동작). */
export function speechLangFor(locale: string | null | undefined): string {
  return SPEECH_LANG[(locale ?? 'ko') as Locale] ?? 'ko-KR';
}

/** pickVoice 가 읽는 보이스의 최소 모양(SpeechSynthesisVoice 의 부분집합 — 테스트에서 흉내 내기 쉽게). */
export interface VoiceLike {
  name?: string;
  lang?: string;
  localService?: boolean;
}

const primary = (tag: string) => tag.toLowerCase().split(/[-_]/)[0];

/**
 * 언어에 맞는 보이스 중 가장 자연스러운 것. 없으면 null — 호출부는 utterance.lang 만 두고 브라우저 기본 보이스에 맡긴다.
 * 점수: Natural/Neural/Online +5 · Google +3 · WaveNet/Studio/Chirp +3 · 클라우드(localService=false) +2 · 정확한 태그 +1.
 * 중국어는 간체(zh-CN · cmn-Hans)를 번체(zh-TW · zh-HK)보다, 영어는 en-US 를 먼저 고른다.
 */
export function pickVoice<T extends VoiceLike>(voices: readonly T[] | null | undefined, lang: string): T | null {
  const want = primary(lang);
  const matches = (voices ?? []).filter((voice) => {
    const tag = (voice.lang ?? '').toLowerCase();
    if (want === 'zh') return tag.startsWith('zh') || tag.startsWith('cmn');
    return primary(tag) === want;
  });
  if (matches.length === 0) return null;
  const exact = lang.toLowerCase().replace('_', '-');
  const score = (voice: T) => {
    const name = (voice.name ?? '').toLowerCase();
    const tag = (voice.lang ?? '').toLowerCase().replace('_', '-');
    let s = 0;
    if (/natural|neural|online/.test(name)) s += 5;
    if (/google/.test(name)) s += 3;
    if (/wavenet|studio|chirp/.test(name)) s += 3;
    if (voice.localService === false) s += 2;
    if (tag === exact) s += 1;
    if (want === 'zh') {
      if (tag === 'zh-cn' || tag.includes('hans')) s += 4;
      else if (/zh-(tw|hk)|hant/.test(tag)) s -= 4;
    }
    return s;
  };
  return matches.slice().sort((a, b) => score(b) - score(a))[0];
}
