// TourAPI 운영시간(usetime·opentime·restdate 원문)을 화면용 줄로 나눈다 — 철·문·요일마다 한 줄.
//
// 왜 필요한가: 원문은 적재 때 손대지 않고 저장된다(transform.py). 그래서 카드 상세의 '운영 시간' 이
// "- 하절기 09:00~22:00- 동절기 09:00~21:00" 처럼 한 줄로 붙어 나오고(도심 29곳), "<br>" 이 글자 그대로
// 보였다(천마총(대릉원)·성덕대왕신종 등 18곳 — React 는 태그를 문자로 그린다). 표시만 바꾼다 — 영업 상태
// 판정(restDate.ts)과 데이터는 그대로다. 모르는 모양은 한 줄 그대로 남는다.

/** 이보다 많으면 자른다 — 상세 패널 한 칸이 운영시간으로 가득 차지 않게. */
const MAX_LINES = 8;

const HEADER_ONLY = /^\[[^\]]+\]$/;
/** '수' · '월~금' · '평일' 같은 짧은 요일·구분 라벨(숫자 없음) — 바로 다음 시각 줄과 한 줄로 붙인다. */
const SHORT_LABEL = /^[^\d]{1,3}$/;

export function hoursLines(raw: string | null | undefined): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const text = raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    // 글 뒤에 붙은 '[주말 및 공휴일]' 머리는 새 줄에서 시작한다.
    .replace(/(\S)\s*(\[[^\]]+\])/g, '$1\n$2')
    // '22:00- 동절기' · ']- 09:00' 처럼 글자에 붙은 '- ' 는 항목 구분이다('09:30 - 17:30' · '09:00-18:00' 은 범위).
    .replace(/(\S)-\s+(?=\S)/g, '$1\n');
  const parts = text
    .split('\n')
    .map((line) => line.trim().replace(/^[-·•]\s*/, '').trim())
    .filter(Boolean);

  const lines: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const line = parts[i];
    const next = parts[i + 1];
    const joinsNext = next !== undefined
      && (HEADER_ONLY.test(line) || (SHORT_LABEL.test(line) && /^\d/.test(next)));
    if (joinsNext) {
      lines.push(`${line} ${next}`);
      i += 1;
    } else {
      lines.push(line);
    }
  }
  return lines.slice(0, MAX_LINES);
}
