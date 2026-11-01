// 대안 화면의 '원래 장소' 규칙 — 웹 apps/web/lib/recommendOrigin.ts 의 화면 쪽 절반(기준 커밋 0d145a1).
// 웹 원본은 regionPacks·congestionEstimate 가 api-client 타입 사슬로 check:shared 에 걸려 import 할 수 없다.
// 주소 만들기(buildRecommendHref)는 호출하는 화면(대기 보드·지도)이 쓰므로 옮기지 않았다.
import type { CongestionKey } from '@/lib/congestionScale';

import { measurementIsCurrentFallback } from './port/congestionEstimate';

export type PlaceKind = 'restaurant' | 'cafe' | 'attraction' | 'culture';

/** 누른 장소의 종류 → 대안으로 물을 종류. 관광지와 문화시설은 한 무리. 모르면 []. */
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

export type RecommendEntry = 'waiting' | 'pick';

/** 대안 화면이 주소에서 읽는 들어온 길 — 머리글이 걷는 시간의 기준(그 장소인가)을 이것으로 정한다. */
export function readRecommendEntry(params: { get(name: string): string | null }): {
  from: RecommendEntry | null;
  walkFromPlace: boolean;
} {
  const raw = params.get('from');
  const from: RecommendEntry | null = raw === 'waiting' || raw === 'pick' ? raw : null;
  return { from, walkFromPlace: from === 'waiting' || (from === 'pick' && params.get('walk') === 'place') };
}

/** 같은 종류로 물었는데 비어 종류 없이 다시 물은 결과에 다른 종류가 섞였는가. */
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

/** 원래 장소의 '지금' 실측 혼잡도(신뢰 등급 · 30분 이내). 없으면 null. */
export function currentOriginLevel(
  logs: readonly OriginCongestionLog[] | null | undefined,
  now: Date = new Date(),
): number | null {
  const log = (logs ?? []).find(
    (l) =>
      l.source !== 'seed' &&
      l.source !== 'simulated' &&
      l.evidence_tier !== 'synthetic' &&
      typeof l.congestion_level === 'number' &&
      Number.isFinite(l.congestion_level) &&
      measurementIsCurrentFallback(l.evidence_tier, l.timestamp, now),
  );
  return log ? (log.congestion_level as number) : null;
}

const HANGUL_FIRST = 0xac00;
const HANGUL_LAST = 0xd7a3;
const DIGIT_HAS_FINAL = [true, true, false, true, false, false, true, true, true, false];

/** 주제 조사 '은/는' — 마지막 글자의 받침으로 고른다. */
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

/** 대안의 붐빔이 눌러 들어온 곳보다 확실히 덜한가. 비교할 곳의 등급을 모르면 false. */
export function isStrictlyCalmer(candidate: CongestionKey, origin: CongestionKey | null): boolean {
  if (origin === null) return false;
  return GRADE_RANK[candidate] < GRADE_RANK[origin];
}

/** 화면이 주소(expo-router 의 문자열 파라미터)에서 읽은 원래 장소. */
export interface RecommendParams {
  facilityId: string;
  name: string;
  type: string | null;
  lat: number | null;
  lng: number | null;
  from: RecommendEntry | null;
  walkFromPlace: boolean;
  fromShare: boolean;
}

type RawParam = string | string[] | undefined;

function first(value: RawParam): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

function finiteOrNull(raw: string): number | null {
  if (raw.trim() === '') return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

/** expo-router useLocalSearchParams 결과 → RecommendParams. 좌표는 둘 다 숫자일 때만 쓴다(웹과 같다). */
export function parseRecommendParams(raw: Record<string, RawParam>): RecommendParams {
  const lat = finiteOrNull(first(raw.lat));
  const lng = finiteOrNull(first(raw.lng));
  const both = lat !== null && lng !== null;
  const entry = readRecommendEntry({ get: (name) => (first(raw[name]) || null) });
  return {
    facilityId: first(raw.facilityId),
    name: first(raw.name).trim(),
    type: first(raw.type) || null,
    lat: both ? lat : null,
    lng: both ? lng : null,
    from: entry.from,
    walkFromPlace: entry.walkFromPlace,
    fromShare: first(raw.ref) === 'share',
  };
}

/** DB 에 없는 장소(카카오 검색 결과)는 시설 id 대신 이름·종류가 온다. */
export function isNamedOrigin(p: Pick<RecommendParams, 'facilityId' | 'name' | 'type'>): boolean {
  return !p.facilityId && p.name.length > 0 && candidateTypesFor(p.type).length > 0;
}

export function hasOrigin(p: Pick<RecommendParams, 'facilityId' | 'name' | 'type'>): boolean {
  return !!p.facilityId || isNamedOrigin(p);
}
