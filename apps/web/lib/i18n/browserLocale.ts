import type { Locale } from './config';

/**
 * 저장된 언어가 없는 첫 방문에서 기기 언어로 화면 언어를 고른다.
 *
 * 왜: 경주에 온 외국인 관광객이 한국어 첫 화면에서 언어 선택을 찾아야 했다(10-10 실서비스 비교 — Apple HIG
 * '모두를 위한 설계', Toss Casual Concept). 기기 언어 목록을 앞에서부터 보고 처음 맞는 것을 쓴다.
 * 목록 **어디에든 한국어가 있으면 ko** — 영어 브라우저를 쓰는 한국 사람(맥·영문 크롬, 발표장 노트북)이 영어 화면을
 * 보지 않게(10-10 리뷰). 아니면 첫 언어로: 일본어면 ja, 중국어(번체 포함)면 zh, 그 밖의 말(영어·프랑스어·태국어…)이면
 * en — 한국어를 모르는 사람에게는 한국어보다 영어가 낫다. 목록이 비면 null(기본값 ko 를 그대로 둔다).
 */
export function pickBrowserLocale(languages: readonly string[] | undefined | null): Locale | null {
  const tags = (languages ?? []).map((l) => String(l).trim().toLowerCase()).filter((l) => l.length > 0);
  if (tags.length === 0) return null;
  const primaryOf = (tag: string) => tag.split(/[-_]/)[0];
  if (tags.some((tag) => primaryOf(tag) === 'ko')) return 'ko';
  const primary = primaryOf(tags[0]);
  if (primary === 'ko') return 'ko';
  if (primary === 'ja') return 'ja';
  if (primary === 'zh') return 'zh';
  return 'en';
}
