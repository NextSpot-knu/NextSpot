// 외부 장소 검색 — 로컬(우리 시설) 검색이 0건일 때만 카카오 → 관광공사 순서로 묻는다.
// 웹 원본(0d145a1): apps/web/app/main/page.tsx 의 검색 effect. 두 글자 미만·로컬에서 찾은 질의는 묻지 않고(쿼터 보호),
// 350ms 디바운스, 질의가 바뀌면 이전 결과를 바로 버린다. 적재 요청(ingest-request)은 D12 에 따라 useIngestRequest 로 둔다.
//
// 외부 AI(App Store 5.1.2(i)): /search/keyword 는 관광공사 검색도 0건이면 서버가 검색어를 외부 LLM(Upstage)으로 다시 쓴다
// (apps/api/app/routers/search.py _rewrite_fallback). API 에 LLM 만 끄는 옵션이 없으므로, 외부 AI 전송을 허용한 경우에만
// /search/keyword 를 부른다. 아직 정하지 않았으면 처음 이 단계에 닿을 때 묻고(promptAiConsent), 허용하지 않으면
// 카카오 장소 검색(/search/places, LLM 없음) 결과만 쓴다 — 관광공사 폴백도 함께 빠진다(aiSkipped).
import { useEffect, useRef, useState } from 'react';

import { promptAiConsent } from '~/features/aiConsent';
import { apiClient } from '~/lib/core/apiClient';
import { useT } from '~/lib/i18n/I18nProvider';

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
  /** 외부 AI 전송을 허용하지 않아 관광공사·AI 재작성 폴백을 건너뛰었다(화면이 안내할 수 있게). */
  aiSkipped?: boolean;
}

const IDLE: PlaceSearchState = { places: [], placesLoading: false, tour: [], tourLoading: false, tourAsked: false };

export function usePlaceSearch(query: string, localMatchCount: number): PlaceSearchState {
  const [state, setState] = useState<PlaceSearchState>(IDLE);
  const sequenceRef = useRef(0);
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;

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
      // 검색어가 외부 AI 로 갈 수 있는 단계 — 허용했을 때만 묻는다(처음이면 여기서 한 번 묻는다).
      const consent = await promptAiConsent(tRef.current);
      if (sequence !== sequenceRef.current) return;
      if (consent !== 'granted') {
        setState({ ...IDLE, aiSkipped: true }); // 관광공사까지 묻지 않았다 — '어디에도 없다' 안내를 띄우지 않는다
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

/**
 * '다음 배치 추가 요청'(G2-21, D12 — 적재 요청은 지금) — 관리자 승인 큐에 넣는다. 웹 page.tsx requestIngest 와 같은 본문·같은 알림.
 * 접수된 뒤에는 버튼을 '요청 접수됨' 으로 잠근다(서버가 같은 contentid 를 조용히 무시하므로). 알림은 홈 알약(useHomeToast().show).
 */
export function useIngestRequest(show: (message: string) => void) {
  const t = useT();
  const [requested, setRequested] = useState<ReadonlySet<string>>(new Set());
  const [pendingId, setPendingId] = useState<string | null>(null);
  const request = async (item: TourApiSearchItem) => {
    setPendingId(item.contentid);
    try {
      await apiClient.post('/api/v1/search/ingest-request', {
        contentid: item.contentid,
        name: item.title,
        contentTypeId: item.contenttypeid ?? null,
      });
      setRequested((prev) => new Set(prev).add(item.contentid));
      show(t('map.ingestRequestDone', { name: item.title }));
    } catch (err) {
      // 서버 문구(레이트리밋 등)가 있으면 그대로 전한다 — 왜 안 됐는지가 정보다.
      show((err instanceof Error && err.message) || t('map.ingestRequestFailed'));
    } finally {
      setPendingId(null);
    }
  };
  return { requested, pendingId, request };
}
