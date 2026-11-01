// 외부 장소 검색 — 로컬(우리 시설) 검색이 0건일 때만 카카오 → 관광공사 순서로 묻는다.
// 웹 원본(0d145a1): apps/web/app/main/page.tsx 의 검색 effect. 두 글자 미만·로컬에서 찾은 질의는 묻지 않고(쿼터 보호),
// 350ms 디바운스, 질의가 바뀌면 이전 결과를 바로 버린다. 적재 요청(ingest-request) UI 는 앱에 두지 않는다.
import { useEffect, useRef, useState } from 'react';

import { apiClient } from '~/lib/core/apiClient';

import { shouldAskExternal } from './homeModel';

export interface PlaceSearchItem {
  placeId: string;
  name: string;
  type?: 'cafe' | 'restaurant' | null;
  latitude: number;
  longitude: number;
  address: string;
  phone?: string | null;
  placeUrl?: string | null;
  categoryName?: string | null;
}

/** 관광공사 키워드 검색 1건 — 우리 데이터가 아니다(출처 블록으로만 그린다). */
export interface TourApiSearchItem {
  contentid: string;
  title: string;
  addr1?: string | null;
  mapx?: number | null;
  mapy?: number | null;
  contenttypeid?: number | null;
  firstimage?: string | null;
}

export const SEARCH_DEBOUNCE_MS = 350;

export interface PlaceSearchState {
  places: PlaceSearchItem[];
  placesLoading: boolean;
  tour: TourApiSearchItem[];
  tourLoading: boolean;
  /** 관광공사까지 물어봤는가 — '어디에도 없다' 안내를 조회 전에 띄우지 않으려는 구분. */
  tourAsked: boolean;
}

const IDLE: PlaceSearchState = { places: [], placesLoading: false, tour: [], tourLoading: false, tourAsked: false };

export function usePlaceSearch(query: string, localMatchCount: number): PlaceSearchState {
  const [state, setState] = useState<PlaceSearchState>(IDLE);
  const sequenceRef = useRef(0);

  useEffect(() => {
    const sequence = ++sequenceRef.current;
    const q = query.trim();
    if (!shouldAskExternal(q, localMatchCount)) {
      setState(IDLE);
      return;
    }
    setState({ ...IDLE, placesLoading: true });
    const timer = setTimeout(async () => {
      let places: PlaceSearchItem[] = [];
      try {
        const res = await apiClient.get('/api/v1/search/places', { params: { q }, timeoutMs: 4500 });
        places = Array.isArray(res?.items) ? res.items : [];
      } catch { /* 무해 폴백 — 빈 목록 */ }
      if (sequence !== sequenceRef.current) return;
      if (places.length > 0) {
        setState({ ...IDLE, places });
        return;
      }
      setState({ ...IDLE, tourLoading: true });
      let tour: TourApiSearchItem[] = [];
      try {
        const res = await apiClient.get('/api/v1/search/keyword', { params: { q }, timeoutMs: 6000 });
        tour = Array.isArray(res?.items) ? (res.items as TourApiSearchItem[]) : [];
      } catch { /* 무해 폴백 */ }
      if (sequence !== sequenceRef.current) return;
      setState({ ...IDLE, tour, tourAsked: true });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, localMatchCount]);

  return state;
}
