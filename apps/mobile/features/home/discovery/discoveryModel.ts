// ✨ 경주 테마(경주가 처음이라면 — G2-14 · D12)의 순수 계산. 웹 /main(page.tsx 1509-1550 · 1926-2027 · 2624-2653 · 4307-4405)을 옮겼다.
//
// 테마 목록·기준 명소 찾기는 웹 lib/gyeongjuDiscovery.ts 를 그대로 쓴다(순수 — check:shared). 문구는 웹 사이드 사전
// (lib/i18n/discovery-messages.ts)을 translate.ts 가 이미 읽는다(R1 — catalog.ts·explore/logic.ts 는 고치지 않는다).
// 요청은 기존 getRecommendations(…, { discoveryTheme }) 하나다. 네이티브 의존이 없어 node 로 테스트한다(discoveryModel.test.ts).
import type { RecommendationResponse } from '~/lib/core/apiClient';
import type { TravelContext } from '~/lib/core/travelContextTypes';
import type { CompareAnchor, SheetCandidate } from '~/features/recommendation-card';
import { anchorNowLevel } from '~/features/recommendation-card/compareHeader';
import { displayWalkingMinutes } from '~/features/explore/port/walking';

import {
  DISCOVERY_THEMES,
  findDiscoveryAnchor,
  getDiscoveryTheme,
  type DiscoveryTheme,
  type DiscoveryThemeId,
} from '@/lib/gyeongjuDiscovery';
import { haversineMeters } from '@/lib/map/geo';
import type { HomeFacility } from '../homeModel';

export { DISCOVERY_THEMES, findDiscoveryAnchor, getDiscoveryTheme, type DiscoveryTheme, type DiscoveryThemeId };

/** 켜진 테마(웹 activeDiscovery) — 기준 명소는 테마를 고른 순간의 지도 시설에서 찾은 것. */
export interface ActiveDiscovery {
  themeId: DiscoveryThemeId;
  anchorId: string;
  anchorName: string;
}

/** 테마를 켤 기준 명소를 찾는다 — 없으면 null(웹은 '조건에 맞는 추천을 그대로' 토스트만, 화면은 그대로). */
export function activateDiscovery(facilities: readonly HomeFacility[], theme: DiscoveryTheme): ActiveDiscovery | null {
  const anchor = findDiscoveryAnchor(facilities, theme);
  return anchor ? { themeId: theme.id, anchorId: anchor.id, anchorName: anchor.name } : null;
}

/** 테마 요청의 여행 조건 — 저장된 조건에 테마의 후보 종류 하나(웹 `{ ...travelContext, categories: [theme.candidateType] }`). */
export function discoveryRequestContext(stored: TravelContext, theme: DiscoveryTheme): TravelContext {
  return { ...stored, categories: [theme.candidateType] };
}

/** 테마 요청이 켜졌을 때 요청 열쇠(칩 대신) — 다른 테마·다른 기준 명소로 바뀌면 새 요청으로 본다. */
export function discoveryRequestKey(active: ActiveDiscovery | null): string | null {
  return active ? `discovery:${active.themeId}:${active.anchorId}` : null;
}

/**
 * 카드 첫 줄의 기준 명소(웹 anchorContextFor 의 테마 갈래) — 이름 = 테마 기준 명소, 등급 = 그 명소의 '지금' 혼잡
 * (가정 시각이면 지금 값은 그 시각의 값이 아니라 쓰지 않는다 — 웹 I10), 거리 = 두 좌표 사이 직선거리.
 */
export function discoveryCompareAnchor(
  active: ActiveDiscovery,
  candidate: SheetCandidate | null,
  facilities: readonly HomeFacility[],
  opts: { estimateById?: Readonly<Record<string, unknown>>; timeShifted?: boolean; now?: Date } = {},
): CompareAnchor | null {
  if (!candidate) return null;
  const anchor = facilities.find((f) => f.id === active.anchorId || f.name === active.anchorName);
  const level = anchor && !opts.timeShifted
    ? anchorNowLevel(
        {
          congestionLevel: anchor.congestionLevel,
          congestionSource: null,
          congestionIsCurrent: anchor.congestionIsCurrent,
          congestionTimestamp: anchor.lastUpdated,
          congestionEstimate: (opts.estimateById ?? {})[anchor.id] ?? null,
        },
        opts.now ?? new Date(),
      )
    : null;
  const target = candidate.facility;
  const distanceM = anchor
    && Number.isFinite(anchor.latitude) && Number.isFinite(anchor.longitude)
    && Number.isFinite(target.latitude) && Number.isFinite(target.longitude)
    ? haversineMeters(anchor.latitude, anchor.longitude, target.latitude, target.longitude)
    : null;
  return { name: active.anchorName, distanceM, level };
}

/** 테마 판의 대안 한 칸(웹 :4367-4399) — 순위 · 이름 · 테마 근거 · 도보 분. 비교 문장은 화면이 t 로 붙인다. */
export interface DiscoveryResultItem {
  id: string;
  rank: number;
  name: string;
  /** 테마 근거 문구 키 — 근거가 없으면 null(줄을 그리지 않는다). */
  matchKey: 'discovery.match.related' | 'discovery.match.fact' | null;
  walkMinutes: number;
}

/** 보이는 추천 상위 3곳 → 판의 칸(웹 rankedFacilities.slice(0, 3)). */
export function discoveryResultItems(visibleRecs: readonly RecommendationResponse[]): DiscoveryResultItem[] {
  return visibleRecs.slice(0, 3).map((r, index) => {
    const match = r.breakdown?.discoveryThemeMatch ?? null;
    return {
      id: String(r.facility.id),
      rank: index + 1,
      name: r.facility.name,
      matchKey: match ? (match.source === 'tourapi_related' ? 'discovery.match.related' : 'discovery.match.fact') : null,
      walkMinutes: displayWalkingMinutes(r.breakdown?.travelTime, r.distanceM),
    };
  });
}
