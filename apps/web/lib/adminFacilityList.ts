import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllPages } from '@/lib/adminLoadState';

/**
 * 관제 '장소 관리' 표(FacilityTable)가 읽는 시설 전량.
 *
 * 왜 따로 두는가: 예전 표는 `.order('name')` 한 번으로 읽어 PostgREST 1000행 캡에 잘렸다 —
 * 이름순으로 "에스커피숍" 뒤의 700곳(음식점 422·카페 272·…)이 관리자 화면에서 보이지 않았다.
 * 여기서는 이미 검증된 `fetchAllPages`(상한 도달 시 throw)로 (name, id) 전순서 페이지를 받는다.
 *
 * - 정렬: name 다음 id — 동명 시설이 페이지 경계에서 겹치거나 빠지지 않게 하는 유일키 전순서.
 * - `is_active` 필터를 걸지 않는다: 관리 화면은 영업 중지·폐업 시설도 목록에 두고 '비활성' 으로 보여 준다.
 */
export interface AdminFacilityRow {
  id: string;
  name: string;
  type: string;
  capacity: number;
  operating_hours?: Record<string, string>;
  is_active?: boolean | null;
}

export const ADMIN_FACILITY_PAGE_SIZE = 1000;
/** 20×1000 = 20,000행. 지금 1,700행이라 닿지 않는다 — 닿으면 잘린 목록 대신 throw. */
export const ADMIN_FACILITY_MAX_PAGES = 20;

export async function fetchAdminFacilityRows(client: SupabaseClient): Promise<AdminFacilityRow[]> {
  return fetchAllPages<AdminFacilityRow>(
    async (from, to) => {
      const { data, error } = await client
        .from('facilities')
        .select('id, name, type, capacity, operating_hours, is_active')
        .order('name', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to);
      if (error) throw error;
      return (data ?? []) as AdminFacilityRow[];
    },
    { pageSize: ADMIN_FACILITY_PAGE_SIZE, maxPages: ADMIN_FACILITY_MAX_PAGES },
  );
}

/**
 * 이름 검색 정규화 — 대소문자와 공백을 무시한다('starbucks' 가 'Starbucks' 를,
 * '황리단길식당' 이 '황리단길 식당' 을 찾는다).
 */
export function normalizeFacilityName(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '');
}

/** 빈 검색어는 모두 맞는다. */
export function matchesFacilityName(name: string, query: string): boolean {
  const q = normalizeFacilityName(query);
  return !q || normalizeFacilityName(name ?? '').includes(q);
}

/**
 * 장소 관리 표의 한 탭에 보일 행 — 유형 + 이름 검색만 본다. `is_active` 로 거르지 않는다
 * (비활성 시설도 목록에 두고 '비활성' 배지로 보여 준다). 입력 순서((name, id) 전순서)를 그대로 둔다.
 */
export function filterAdminFacilities<T extends Pick<AdminFacilityRow, 'type' | 'name'>>(
  rows: readonly T[],
  category: string,
  query: string,
): T[] {
  return rows.filter((row) => row.type === category && matchesFacilityName(row.name, query));
}

/** 검색어에 맞는 행 수를 유형별로 센다 — 지금 탭에 0곳일 때 '카페 탭에 2곳' 처럼 다른 탭을 알려 준다. */
export function countNameMatchesByType(
  rows: readonly Pick<AdminFacilityRow, 'type' | 'name'>[],
  query: string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!normalizeFacilityName(query)) return counts;
  for (const row of rows) {
    if (matchesFacilityName(row.name, query)) counts[row.type] = (counts[row.type] ?? 0) + 1;
  }
  return counts;
}
