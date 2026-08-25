export type DiscoveryThemeId =
  | 'silla_core'
  | 'night_heritage'
  | 'hanok_cafe'
  | 'indoor_history'
  | 'gyochon_walk';

export type DiscoveryCandidateType = 'restaurant' | 'cafe' | 'attraction' | 'culture';

export interface DiscoveryTheme {
  id: DiscoveryThemeId;
  emoji: string;
  anchorAliases: readonly string[];
  candidateType: DiscoveryCandidateType;
  filterId: '음식점' | '카페' | '관광지' | '문화시설';
  preferenceIntent: string;
}

/**
 * 유명 장소는 추천 결과가 아니라 사용자가 원하는 경험을 설명하는 기준점이다.
 * 서버는 이 기준점의 TourAPI 연관 정보와 현재 여행 조건을 이용해 같은 유형의 대안을
 * 다시 SPOT 순으로 매긴다. 장거리 권역(불국사·보문·동해)은 현재 도보 서비스 범위와
 * 맞지 않아 의도적으로 넣지 않는다.
 */
export const DISCOVERY_THEMES: readonly DiscoveryTheme[] = [
  {
    id: 'silla_core',
    emoji: '👑',
    anchorAliases: ['대릉원', '대릉원 천마총', '대릉원(천마총)'],
    candidateType: 'attraction',
    filterId: '관광지',
    preferenceIntent: '신라 역사 유적 산책',
  },
  {
    id: 'night_heritage',
    emoji: '🌙',
    anchorAliases: ['동궁과 월지', '경주 동궁과 월지'],
    candidateType: 'attraction',
    filterId: '관광지',
    preferenceIntent: '야경 경관 산책',
  },
  {
    id: 'hanok_cafe',
    emoji: '☕',
    anchorAliases: ['황리단길 공예공방거리', '황리단길', '대릉원', '대릉원 천마총', '대릉원(천마총)'],
    candidateType: 'cafe',
    filterId: '카페',
    preferenceIntent: '한옥 감성 카페 디저트',
  },
  {
    id: 'indoor_history',
    emoji: '🏛️',
    anchorAliases: ['국립경주박물관', '경주국립박물관'],
    candidateType: 'culture',
    filterId: '문화시설',
    preferenceIntent: '실내 역사 전시 박물관',
  },
  {
    id: 'gyochon_walk',
    emoji: '🌉',
    anchorAliases: ['월정교', '경주 월정교'],
    candidateType: 'attraction',
    filterId: '관광지',
    preferenceIntent: '교촌 월정교 전통 산책',
  },
] as const;

export interface DiscoveryAnchorCandidate {
  id: string;
  name: string;
}

export function normalizeDiscoveryPlaceName(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('ko-KR')
    .replace(/[()（）·\-_/\s]/g, '');
}

/** 동명·부분문자열 오연결을 막기 위해 정규화한 이름의 완전 일치만 허용한다. */
export function findDiscoveryAnchor<T extends DiscoveryAnchorCandidate>(
  facilities: readonly T[],
  theme: DiscoveryTheme,
): T | null {
  const byName = new Map<string, T[]>();
  for (const facility of facilities) {
    const key = normalizeDiscoveryPlaceName(facility.name);
    const existing = byName.get(key) ?? [];
    existing.push(facility);
    byName.set(key, existing);
  }
  for (const alias of theme.anchorAliases) {
    const matches = byName.get(normalizeDiscoveryPlaceName(alias)) ?? [];
    // 같은 정규화 이름이 여러 시설이면 임의의 좌표를 기준점으로 고르지 않는다.
    if (matches.length === 1) return matches[0];
  }
  return null;
}

export function getDiscoveryTheme(id: DiscoveryThemeId): DiscoveryTheme {
  const theme = DISCOVERY_THEMES.find((item) => item.id === id);
  if (!theme) throw new Error(`Unknown discovery theme: ${id}`);
  return theme;
}
