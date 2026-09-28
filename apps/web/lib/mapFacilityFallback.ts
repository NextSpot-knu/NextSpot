import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllPages } from '@/lib/adminLoadState';
import { chunk } from '@/lib/adminMetricState';

/**
 * /main 지도의 비상 경로 — 백엔드 `/api/v1/infrastructures` 가 실패하거나 4초를 넘길 때만 돈다.
 *
 * 예전 경로의 결함(2026-09-28 실측):
 * - `is_active` 를 걸지 않아 지도 범위 안의 영업 중지·폐업 16곳이 그려졌다(서버 경로는 활성만 준다).
 * - `gallery_images` 를 읽지 않아, 대표 사진이 없는 카드가 갤러리 사진 폴백을 잃었다.
 * - 혼잡은 `congestion_logs` 최신 3000행(실제로는 1000행 캡)을 받아 클라이언트에서 시설별 최신을
 *   골랐다 — 한 시설의 제보가 1000건을 넘으면 다른 시설의 혼잡이 조용히 빠지고, 서버의
 *   seed/simulated/parking_derived 이름 배제도 없었다.
 *
 * 여기서는 활성 시설만 id 전순서 페이지로 받고, 혼잡은 서버와 같은 DISTINCT ON RPC
 * (`latest_congestion_for_facilities`, SECURITY INVOKER·anon 읽기 가능)를 시설 1000곳씩 묶어 부른다.
 * RPC 는 시설당 최대 1행이라 1000개 묶음이 PostgREST 1000행 캡에 닿지 않는다.
 */

export interface MapBounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export interface FallbackCongestionRow {
  facility_id: string;
  congestion_level: number;
  current_count: number | null;
  timestamp: string;
  source: string;
  evidence_tier: 'synthetic' | 'single_report' | 'corroborated' | 'verified';
}

/** MAP_FALLBACK_SELECT 의 한 행(snake_case 원본 — 지도 매핑 블록이 camelCase 로 옮긴다). */
export interface MapFallbackFacilityRow {
  id: string;
  name: string;
  type: string;
  latitude: number;
  longitude: number;
  capacity: number;
  operating_hours: unknown;
  features: unknown;
  address: string | null;
  image_url: string | null;
  gallery_images: unknown;
  phone: string | null;
  homepage: string | null;
  overview: string | null;
  barrier_free: unknown;
  contentid: string | null;
  contenttypeid: string | null;
}

export interface MapFacilityFallbackResult {
  rows: MapFallbackFacilityRow[];
  latestBy: Record<string, FallbackCongestionRow>;
  /** RPC 가 실패했다 — 지도는 그대로 그리고 혼잡만 '모름' 으로 둔다. */
  congestionFailed: boolean;
}

/** 오늘의 지도 컬럼 + 갤러리 사진(카드 사진 폴백). 1순위 API 경로와 같은 필드 집합. */
export const MAP_FALLBACK_SELECT =
  'id, name, type, latitude, longitude, capacity, operating_hours, features, address, image_url, gallery_images, phone, homepage, overview, barrier_free, contentid, contenttypeid';

export const MAP_FALLBACK_PAGE_SIZE = 1000;
/** 5×1000 = 5,000곳. 지금 지도 범위 안은 674곳 — 닿으면 잘린 지도 대신 throw. */
export const MAP_FALLBACK_MAX_PAGES = 5;
/** 서버 reference_snapshot.RPC_CHUNK 와 같은 값. RPC 가 시설당 ≤1행이라 1000행 캡 안이다. */
export const FALLBACK_RPC_CHUNK = 1000;

/** API 의 `_clean_gallery_images`(infrastructures.py) 미러 — 배열이 아니면 null, 빈 문자열·비문자열은 버리고, 비면 null. */
export function cleanGalleryImages(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const urls = value.filter((u): u is string => typeof u === 'string' && u.trim().length > 0);
  return urls.length > 0 ? urls : null;
}

export async function loadMapFacilitiesFromSupabase(
  client: SupabaseClient,
  bounds: MapBounds,
): Promise<MapFacilityFallbackResult> {
  // 시설 실패는 throw — 호출부의 기존 catch 가 '캐시도 없을 때만 다시 시도 안내' 를 맡는다.
  const rows = await fetchAllPages<MapFallbackFacilityRow>(
    async (from, to) => {
      const { data, error } = await client
        .from('facilities')
        .select(MAP_FALLBACK_SELECT)
        .eq('is_active', true)
        .gte('latitude', bounds.minLat)
        .lte('latitude', bounds.maxLat)
        .gte('longitude', bounds.minLng)
        .lte('longitude', bounds.maxLng)
        .order('id', { ascending: true })
        .range(from, to);
      if (error) throw error;
      return (data ?? []) as unknown as MapFallbackFacilityRow[];
    },
    { pageSize: MAP_FALLBACK_PAGE_SIZE, maxPages: MAP_FALLBACK_MAX_PAGES },
  );

  const latestBy: Record<string, FallbackCongestionRow> = {};
  const ids = rows.map((r) => String(r.id));
  if (ids.length === 0) return { rows, latestBy, congestionFailed: false };

  try {
    const parts = await Promise.all(
      chunk(ids, FALLBACK_RPC_CHUNK).map(async (part) => {
        const { data, error } = await client.rpc('latest_congestion_for_facilities', { facility_ids: part });
        if (error) throw error;
        return (data ?? []) as FallbackCongestionRow[];
      }),
    );
    for (const part of parts) {
      for (const row of part) latestBy[String(row.facility_id)] = row;
    }
    return { rows, latestBy, congestionFailed: false };
  } catch (err) {
    console.warn('지도 비상 경로: 최신 혼잡 RPC 실패 — 혼잡 없이 지도를 그린다:', err);
    return { rows, latestBy: {}, congestionFailed: true };
  }
}
