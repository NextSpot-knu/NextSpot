// /waiting 카드를 누르면 열리는 /explore/recommend 의 '출발점' 규칙(2026-10-06 감사 I25).
//
// 예전에는 대기 보드가 어느 카드를 누르든 지역 중심(REGION.center) 좌표만 넘겼다. 그래서 첨성대를 눌러도 피자집을
// 눌러도 같은 황리단길 카페·식당이 '대안' 으로 나왔고, '도보 2분' 도 지역 중심에서 잰 값이었다. 이제는 누른 장소의
// 좌표와 종류를 넘겨, 그 장소 둘레의 **같은 종류** 대안을 그 장소에서 걷는 시간으로 보여 준다.
//
// 지도(/main)에서 핀·검색으로 연 장소의 '대신 갈 곳 보기'(P1-5)도 같은 주소를 쓴다 — 가려던 붐비는 곳 대신 고를
// 곳이 이 서비스의 핵심 동작인데, 예전에는 그 입구가 대기 보드 상위 8곳에만 있었다.

import { GYEONGJU_PACK, type RegionPack } from './regionPacks';
import type { CongestionKey } from './congestionScale';
import { measurementIsCurrentFallback } from './congestionEstimate';

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
  /**
   * 우리 DB 시설 id. 카카오 장소 검색 결과처럼 아직 적재되지 않은 장소면 없다 — 그때는 이름과 종류로 묻는다
   * (대안 화면이 원래 장소 없이 같은 종류를 그 둘레에서 찾는다).
   */
  facilityId?: string | null;
  /** 시설 id 가 없을 때만 주소에 싣는다(머리글의 '{장소} 대신'). */
  name?: string | null;
  type: string;
  /** 옛 보드 캐시 행에는 없다 — 그때는 지역 중심으로 묻는다(오늘의 동작). */
  latitude?: number | null;
  longitude?: number | null;
}

/**
 * 대안 화면에 들어온 길.
 *  · 'waiting' — 대기 보드 카드. 걷는 시간은 **그 장소에서** 잰다.
 *  · 'pick'    — 지도 핀·검색으로 고른 장소의 '대신 갈 곳 보기'(P1-5). 내 위치를 알면 **내 위치에서** 잰다.
 */
export type RecommendEntry = 'waiting' | 'pick';

export interface RecommendHrefOptions {
  from?: RecommendEntry;
  /** 'pick' 에서만 쓰는 지금 내 위치. 모르면 null — 그때는 그 장소에서 잰다. */
  user?: { lat: number; lng: number } | null;
  /**
   * 좌표를 모를 때 쓰는 지역 중심. 주지 않으면 경주(GYEONGJU_PACK — lib/region.ts REGION.center 와 같은 값)라 경주 주소는
   * 오늘과 같다. 내부 검증 지역 화면은 그 지역 묶음을 넘긴다.
   */
  pack?: Pick<RegionPack, 'center'>;
}

function validPoint(lat: unknown, lng: unknown): lat is number {
  return typeof lat === 'number' && Number.isFinite(lat) && typeof lng === 'number' && Number.isFinite(lng);
}

/**
 * 대안 화면 주소. 걷는 시간을 어디서 잴지가 주소의 lat/lng 다.
 *  · 대기 보드(기본): 좌표가 둘 다 숫자일 때만 그 장소, 아니면 지역 중심. 'from=waiting' 은 좌표가 있을 때만 붙인다 —
 *    그 표시가 머리글을 '{장소}에서 걸어서 갈 수 있는 곳' 으로 바꾸는데, 옛 캐시 행(좌표 없음)은 지역 중심에서 잰
 *    걷는 시간이라 그 장소에서 걷는다고 말할 수 없다.
 *  · 고른 장소('pick'): 내 위치를 알면 내 위치(대안 카드의 '도보 N분' 이 지도 카드처럼 나에게서 잰 값이 된다).
 *    모르면 그 장소 좌표로 묻고 'walk=place' 를 붙인다 — 지역 중심에서 잰 걷는 시간을 내 거리처럼 보이지 않게,
 *    머리글이 '{장소}에서 걸어서 갈 수 있는 곳' 으로 그 기준을 말한다.
 */
export function buildRecommendHref(row: RecommendOriginRow, options: RecommendHrefOptions = {}): string {
  const from = options.from ?? 'waiting';
  const placeKnown = validPoint(row.latitude, row.longitude);
  const user = from === 'pick' && options.user && validPoint(options.user.lat, options.user.lng) ? options.user : null;
  const center = (options.pack ?? GYEONGJU_PACK).center;
  const lat = user ? user.lat : placeKnown ? (row.latitude as number) : center.lat;
  const lng = user ? user.lng : placeKnown ? (row.longitude as number) : center.lng;
  const params = new URLSearchParams();
  if (row.facilityId) params.set('facilityId', row.facilityId);
  else if (row.name) params.set('name', row.name);
  params.set('lat', String(lat));
  params.set('lng', String(lng));
  params.set('type', row.type);
  if (from === 'pick') {
    params.set('from', 'pick');
    if (!user && placeKnown) params.set('walk', 'place');
  } else if (placeKnown) {
    params.set('from', 'waiting');
  }
  return `/explore/recommend?${params.toString()}`;
}

/** 대안 화면이 주소에서 읽는 들어온 길 — 머리글이 걷는 시간의 기준(그 장소인가)을 이것으로 정한다. */
export function readRecommendEntry(params: { get(name: string): string | null }): {
  from: RecommendEntry | null;
  walkFromPlace: boolean;
} {
  const raw = params.get('from');
  const from: RecommendEntry | null = raw === 'waiting' || raw === 'pick' ? raw : null;
  return { from, walkFromPlace: from === 'waiting' || (from === 'pick' && params.get('walk') === 'place') };
}

/**
 * 같은 종류로 물었는데 비어 종류 없이 다시 물은 결과에 **다른 종류가 섞였는가**(P1-5). 그때만 '같은 종류가 없어
 * 다른 종류를 보여 드려요' 한 줄을 띄운다 — 카페를 눌렀는데 말없이 식당이 오면 고장으로 읽힌다. 종류를 묻지 않은
 * 화면(옛 링크·공유 링크)은 비교할 기준이 없어 말하지 않는다.
 */
export function showsOtherKinds(
  candidateTypes: readonly string[],
  results: readonly { facility: { type: string } }[],
): boolean {
  if (candidateTypes.length === 0) return false;
  return results.some((item) => !candidateTypes.includes(item.facility.type));
}

/** 원래 장소의 congestion_logs 한 줄(최신순으로 온다). */
export interface OriginCongestionLog {
  congestion_level?: number | null;
  timestamp?: string | null;
  source?: string | null;
  evidence_tier?: string | null;
}

/**
 * 원래 장소의 **지금** 실측 혼잡도. '지금' 자격(신뢰 등급 · 30분 이내 — 백엔드 measurement_is_current 의 미러)이
 * 있는 시드·합성 아닌 관측만 쓰고, 없으면 null(그때 화면은 추정 피드에서 '추정' 표시와 함께 읽는다).
 * 46일 된 관측을 '지금 여유로운 편이에요' 로 말하면, 방금 보드가 '추정 혼잡' 이라고 한 곳과 다른 말을 한다.
 */
export function currentOriginLevel(
  logs: readonly OriginCongestionLog[] | null | undefined,
  now: Date = new Date(),
): number | null {
  const log = (logs ?? []).find((l) =>
    l.source !== 'seed' && l.source !== 'simulated' && l.evidence_tier !== 'synthetic'
    && typeof l.congestion_level === 'number' && Number.isFinite(l.congestion_level)
    && measurementIsCurrentFallback(l.evidence_tier, l.timestamp, now),
  );
  return log ? (log.congestion_level as number) : null;
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
