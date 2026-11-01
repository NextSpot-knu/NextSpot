// 핀 겹침 줄이기 — 웹 /main computeDisplayFacilities 의 '지도 쪽' 절반을 지도 SDK 없이 옮긴 것.
//
// 웹 원본: apps/web/app/main/page.tsx `computeDisplayFacilities`(기준 커밋 e07ea61). 웹은 카카오의
// getBounds()·getProjection()·getLevel() 을 동기로 불렀다. 여기서는 지도가 알려 준 영역(Region)과 지도 상자
// 크기(ViewSize)로 같은 판정을 한다(geometry.ts). 순서는 웹과 같다:
//   1) 영역 밖 장소를 뺀다(bounds.contain).
//   2) 같은 건물 묶기 — 정규화한 주소가 8자 이상으로 같고 30m 이내면 한 핀(멀티테넌트 점포).
//   3) 우선순위 순서대로 놓되 이미 놓은 핀과 화면에서 52px(검색 중 40px) 이상 떨어진 것만.
//   4) 상한 — 검색 중 12, 아니면 level ≤3: 12 · level ≥5: 5 · 그 사이 7.
// 지도가 아직 없으면(영역 모름) 웹처럼 묶지 않고 앞에서 상한만큼 자른다(검색 12 · 아니면 7).
// 무엇을 먼저 놓을지(서버 순위 → SPOT)와 묶음 핀을 어떻게 칠할지는 화면이 정한다 — 여기는 지도 기하만 맡는다.
// 순수 모듈 — react-native 를 모른다.

import { haversineMeters } from '@/lib/map/geo';

import { isInRegion, kakaoLevelRounded, projectToView, type Region, type ViewSize } from './geometry';

export interface DeclutterItem {
  id: string | number;
  latitude: number;
  longitude: number;
  address?: string | null;
}

export interface PinCluster<T> {
  /** 핀 키 — 하나면 String(id), 묶음이면 웹과 같은 `building:<id,id,…>`(정렬). */
  key: string;
  /** 대표(첫 구성원). 핀은 평균점이 아니라 이 장소의 실제 좌표에 선다(웹과 같다). */
  anchor: T;
  members: T[];
}

export interface Viewport {
  region: Region;
  size: ViewSize;
}

/** 같은 건물로 보는 최대 거리(m). */
export const SAME_BUILDING_MAX_M = 30;
/** 이보다 짧은 주소(행정동처럼 뭉뚱그린 주소)는 같아도 묶지 않는다. */
export const SAME_BUILDING_MIN_ADDRESS_LEN = 8;
/** 핀 사이 최소 화면 간격(dp) — 평소 52, 검색 중 40. */
export const PIN_GAP_PX = { normal: 52, searching: 40 } as const;
/** 지도가 아직 없을 때의 상한. */
export const FALLBACK_LIMIT = { normal: 7, searching: 12 } as const;

/** 공백을 모두 뺀 주소. */
export function normalizeAddress(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, '').trim();
}

/** 확대 단계(정수 카카오 level)별 핀 상한 — 웹과 같다. */
export function markerLimit(level: number, searching = false): number {
  if (searching) return 12;
  if (level <= 3) return 12;
  if (level >= 5) return 5;
  return 7;
}

/** 같은 건물 묶기 — 입력 순서를 지키고, 각 묶음의 첫 구성원(anchor)과만 비교한다(웹과 같다). */
export function groupSameBuilding<T extends DeclutterItem>(items: readonly T[]): PinCluster<T>[] {
  const clusters: T[][] = [];
  for (const item of items) {
    const address = normalizeAddress(item.address);
    const cluster = clusters.find((members) => {
      const anchor = members[0];
      return address.length >= SAME_BUILDING_MIN_ADDRESS_LEN
        && normalizeAddress(anchor.address) === address
        && haversineMeters(anchor.latitude, anchor.longitude, item.latitude, item.longitude) <= SAME_BUILDING_MAX_M;
    });
    if (cluster) cluster.push(item);
    else clusters.push([item]);
  }
  return clusters.map((members) => ({
    key: members.length === 1 ? String(members[0].id) : `building:${members.map((m) => String(m.id)).sort().join(',')}`,
    anchor: members[0],
    members,
  }));
}

/**
 * 지금 영역에서 그릴 핀. items 는 놓을 순서(우선순위 높은 것 먼저)로 넘긴다.
 * viewport 가 null 이면(지도 준비 전) 웹처럼 묶지 않고 상한만큼 자른다.
 */
export function declutterPins<T extends DeclutterItem>(
  items: readonly T[],
  viewport: Viewport | null,
  options: { searching?: boolean } = {},
): PinCluster<T>[] {
  const searching = options.searching ?? false;
  const valid = items.filter((f) => Number.isFinite(f.latitude) && Number.isFinite(f.longitude));
  if (!viewport || viewport.size.width <= 0 || viewport.size.height <= 0) {
    return valid
      .slice(0, searching ? FALLBACK_LIMIT.searching : FALLBACK_LIMIT.normal)
      .map((f) => ({ key: String(f.id), anchor: f, members: [f] }));
  }
  const { region, size } = viewport;
  const visible = valid.filter((f) => isInRegion(f, region));
  const candidates = groupSameBuilding(visible);
  const gap = searching ? PIN_GAP_PX.searching : PIN_GAP_PX.normal;
  const limit = markerLimit(kakaoLevelRounded(region, size), searching);
  const placed: PinCluster<T>[] = [];
  const points: { x: number; y: number }[] = [];
  for (const cluster of candidates) {
    const point = projectToView(cluster.anchor, region, size);
    if (points.every((other) => Math.hypot(point.x - other.x, point.y - other.y) >= gap)) {
      placed.push(cluster);
      points.push(point);
    }
    if (placed.length >= limit) break;
  }
  return placed;
}
