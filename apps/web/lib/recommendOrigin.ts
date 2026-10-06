// /waiting 카드를 누르면 열리는 /explore/recommend 의 '출발점' 규칙(2026-10-06 감사 I25).
//
// 예전에는 대기 보드가 어느 카드를 누르든 지역 중심(REGION.center) 좌표만 넘겼다. 그래서 첨성대를 눌러도 피자집을
// 눌러도 같은 황리단길 카페·식당이 '대안' 으로 나왔고, '도보 2분' 도 지역 중심에서 잰 값이었다. 이제는 누른 장소의
// 좌표와 종류를 넘겨, 그 장소 둘레의 **같은 종류** 대안을 그 장소에서 걷는 시간으로 보여 준다.

import { REGION } from './region';
import type { CongestionKey } from './congestionScale';

export type PlaceKind = 'restaurant' | 'cafe' | 'attraction' | 'culture';

/** 누른 장소의 종류 → 대안으로 물을 종류. 관광지와 문화시설은 한 무리(유적 옆 박물관도 같은 나들이). 모르면 []. */
export function candidateTypesFor(type: string | null | undefined): PlaceKind[] {
  switch (type) {
    case 'attraction':
    case 'culture':
      return ['attraction', 'culture'];
    case 'restaurant':
      return ['restaurant'];
    case 'cafe':
      return ['cafe'];
    default:
      return [];
  }
}

export interface RecommendOriginRow {
  facilityId: string;
  type: string;
  /** 옛 보드 캐시 행에는 없다 — 그때는 지역 중심으로 묻는다(오늘의 동작). */
  latitude?: number | null;
  longitude?: number | null;
}

/** 대기 보드 카드 → 대안 화면 주소. 좌표가 둘 다 숫자일 때만 그 좌표, 아니면 지역 중심. */
export function buildRecommendHref(row: RecommendOriginRow): string {
  const hasCoords =
    typeof row.latitude === 'number' && Number.isFinite(row.latitude)
    && typeof row.longitude === 'number' && Number.isFinite(row.longitude);
  const lat = hasCoords ? (row.latitude as number) : REGION.center.lat;
  const lng = hasCoords ? (row.longitude as number) : REGION.center.lng;
  const params = new URLSearchParams({
    facilityId: row.facilityId,
    lat: String(lat),
    lng: String(lng),
    type: row.type,
    from: 'waiting',
  });
  return `/explore/recommend?${params.toString()}`;
}

const HANGUL_FIRST = 0xac00;
const HANGUL_LAST = 0xd7a3;
// 0 영 · 1 일 · 2 이 · 3 삼 · 4 사 · 5 오 · 6 육 · 7 칠 · 8 팔 · 9 구 — 받침이 있는 숫자.
const DIGIT_HAS_FINAL = [true, true, false, true, false, false, true, true, true, false];

/**
 * 주제 조사 '은/는'. 화면에 '은(는)' 을 그대로 쓰지 않는다 — 마지막 글자의 받침으로 고른다.
 * 괄호·따옴표·공백은 건너뛴다. 영문은 마지막 글자가 l·m·n 이면 받침이 있다고 본다(짐작이지만 '은(는)' 보다 자연스럽다).
 */
export function topicJosa(name: string): '은' | '는' {
  const trimmed = name.replace(/[\s)\]}"'’”」』>.,!?·-]+$/u, '');
  const last = trimmed.slice(-1);
  if (!last) return '는';
  const code = last.charCodeAt(0);
  if (code >= HANGUL_FIRST && code <= HANGUL_LAST) return (code - HANGUL_FIRST) % 28 === 0 ? '는' : '은';
  if (/[0-9]/.test(last)) return DIGIT_HAS_FINAL[Number(last)] ? '은' : '는';
  if (/[lmn]/i.test(last)) return '은';
  return '는';
}

export function withTopicJosa(name: string): string {
  return `${name}${topicJosa(name)}`;
}

const GRADE_RANK: Record<CongestionKey, number> = { quiet: 0, relaxed: 1, moderate: 2, busy: 3 };

/** 대안의 붐빔이 눌러 들어온 곳보다 확실히 덜한가. 비교할 곳의 등급을 모르면 false(말하지 않는다). */
export function isStrictlyCalmer(candidate: CongestionKey, origin: CongestionKey | null): boolean {
  if (origin === null) return false;
  return GRADE_RANK[candidate] < GRADE_RANK[origin];
}
