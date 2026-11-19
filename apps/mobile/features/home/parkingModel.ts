// 홈 주차장 탭의 순수 규칙(G2-25 5번 · H2b) — react-native 를 모른다(테스트: parkingModel.test.ts).
//
// 웹 원본: apps/web/app/main/page.tsx — 주차장 탭 effect(1231-1279, 응답 매핑 · 선택 유지), 마커 effect 의 주차장 핀
// (3087-3107: 실시간 값이 있을 때만 점유율로 칠한다), 선택 카드(4662-4690: 잔여면 상자는 실시간 값이 다 있을 때만).
// 주차장 탭은 장소 DB 가 아니라 경주시 ITS 의 공식 위치·실시간 잔여면을 직접 쓴다.
import { pinDisplay } from '@/lib/map/markerSvg';
import type { PinCluster } from '~/features/map/declutter';
import type { PinMarker } from '~/features/map/types';

export interface ParkingLot {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  /** 지금 위치에서의 거리(m, 서버 계산). */
  distanceM: number;
  totalSpaces: number | null;
  availableSpaces: number | null;
  /** 점유율(0~1). 실시간 값이 아니면 핀을 칠하지 않는다. */
  occupancy: number | null;
  live: boolean;
  observedAt: string | null;
  source: string | null;
}

/** 웹 /main 주차장 탭이 묻는 반경(m). */
export const PARKING_RADIUS_M = 5000;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** GET /api/v1/area-demand/parking-lots 응답 → 화면 목록. id·이름·좌표가 없는 항목은 버린다(웹 매핑 그대로). */
export function mapParkingLots(response: unknown): ParkingLot[] {
  const lots = (response as { lots?: unknown } | null)?.lots;
  if (!Array.isArray(lots)) return [];
  return lots
    .map((raw): ParkingLot => {
      const lot = (raw ?? {}) as Record<string, unknown>;
      return {
        id: String(lot.id ?? ''),
        name: String(lot.name ?? ''),
        latitude: Number(lot.latitude),
        longitude: Number(lot.longitude),
        distanceM: Number(lot.distanceM ?? 0),
        totalSpaces: num(lot.totalSpaces),
        availableSpaces: num(lot.availableSpaces),
        occupancy: num(lot.occupancy),
        live: lot.live === true,
        observedAt: typeof lot.observedAt === 'string' ? lot.observedAt : null,
        source: typeof lot.source === 'string' ? lot.source : null,
      };
    })
    .filter((lot) => lot.id && lot.name && Number.isFinite(lot.latitude) && Number.isFinite(lot.longitude));
}

/** 새로 받은 목록에서 선택을 이어 간다 — 같은 id 가 있으면 그것, 없거나 처음이면 첫 주차장(가장 가까운 곳 — 서버가 거리순). */
export function keepParkingSelection(current: ParkingLot | null, lots: readonly ParkingLot[]): ParkingLot | null {
  if (current) return lots.find((lot) => lot.id === current.id) ?? lots[0] ?? null;
  return lots[0] ?? null;
}

/** 잔여면 상자를 그릴지 — 실시간이고 잔여·총 면수가 다 있을 때만(없다는 사실은 할 일을 주지 않는다). */
export function liveSpacesOf(lot: ParkingLot): { available: number; total: number } | null {
  if (!lot.live || lot.availableSpaces === null || lot.totalSpaces === null) return null;
  return { available: lot.availableSpaces, total: lot.totalSpaces };
}

/** '현재 위치에서 약 {n}m' 의 n — 올림 + 천 단위 쉼표(웹 Math.ceil(distanceM).toLocaleString()). */
export function parkingDistanceText(distanceM: number): string {
  const n = Math.ceil(Number.isFinite(distanceM) ? distanceM : 0);
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export interface ParkingPinContext {
  selectedId: string | null;
  busyAt: number;
  now: Date;
  /** 혼잡 예측 띠가 +N 예측을 보이는 중인가(웹 forecastMode — 주차장 핀은 예측 값이 없어 빈 핀/실측 그대로). */
  forecastMode?: boolean;
}

/**
 * 놓기로 한 주차장(declutterPins 결과 — 웹도 주차장을 같은 밀집도 상한으로 거른다) → 지도 핀. 실시간 점유율이 있을 때만
 * 등급색, 아니면 빈 핀. 주차장은 주소가 없어 묶이지 않는다(구성원 하나).
 */
export function parkingPinMarkers(clusters: readonly PinCluster<ParkingLot>[], ctx: ParkingPinContext): PinMarker[] {
  return clusters.map((cluster) => {
    const lot = cluster.anchor;
    const selected = ctx.selectedId === lot.id;
    const pin = pinDisplay({
      type: 'parking',
      level: lot.live ? lot.occupancy : null,
      observedAt: lot.observedAt,
      source: lot.source,
      rank: null,
      forecastMode: ctx.forecastMode ?? false,
      forecastLevel: null,
      selected,
      phone: true,
      busyAt: ctx.busyAt,
      now: ctx.now,
    });
    return {
      kind: 'pin' as const,
      id: `parking:${lot.id}`,
      coordinate: { latitude: lot.latitude, longitude: lot.longitude },
      title: lot.name,
      zIndex: pin.zIndex,
      pin,
      placeType: 'parking',
      selected,
      data: lot,
    };
  });
}
