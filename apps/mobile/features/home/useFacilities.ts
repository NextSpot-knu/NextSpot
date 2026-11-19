// 지도 시설 목록 + 5분마다 받는 추정 피드.
//
// 웹 원본(0d145a1): apps/web/app/main/page.tsx 의 loadFacilities(1순위 /infrastructures 만 — Supabase 직접 읽기 폴백은 옮기지
// 않았다) · 추정 피드 effect(보이는 동안 5분마다, 실패는 조용히). 24시간 캐시는 localStorage(expo-sqlite)에 같은 키로 둔다.
import { useCallback, useEffect, useRef, useState } from 'react';

import { REGION } from '@/lib/region';
import { apiClient, loadSharedCongestionEstimates } from '~/lib/core/apiClient';
import { usePolling } from '~/lib/platform/appState';

import { estimatesFromFeed, mapInfrastructures, type HomeFacility } from './homeModel';

const CACHE_KEY = 'nextspot_facilities_cache_v3';
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const ESTIMATE_POLL_MS = 5 * 60 * 1000;

interface CacheEntry {
  savedAt: number;
  facilities: HomeFacility[];
}

function store(): Storage | null {
  return (globalThis as { localStorage?: Storage }).localStorage ?? null;
}

function readCache(now = Date.now()): HomeFacility[] | null {
  try {
    const parsed = JSON.parse(store()?.getItem(CACHE_KEY) || 'null') as CacheEntry | null;
    if (!parsed?.savedAt || !Array.isArray(parsed.facilities)) return null;
    if (now - parsed.savedAt > CACHE_MAX_AGE_MS) return null;
    // 30분짜리 '지금' 판정을 캐시가 되살리지 않는다 — 캐시로 그린 첫 화면은 판정을 모른다(undefined = 종전 규칙).
    return parsed.facilities.map((f) => ({ ...f, congestionIsCurrent: undefined }));
  } catch {
    return null;
  }
}

function writeCache(facilities: HomeFacility[]): void {
  try {
    store()?.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), facilities } satisfies CacheEntry));
  } catch { /* 저장 공간 문제 — 최신 네트워크 경로에는 영향 없다 */ }
}

export interface FacilitiesState {
  facilities: HomeFacility[];
  loading: boolean;
  error: boolean;
  reload: () => void;
  /** {시설 id: 원본 추정}. 그릴 때 freshEstimate 로 60분을 다시 본다(저장하지 않는다). */
  estimateById: Record<string, unknown>;
}

export function useFacilities(): FacilitiesState {
  const [facilities, setFacilities] = useState<HomeFacility[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [estimateById, setEstimateById] = useState<Record<string, unknown>>({});
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    const cached = readCache();
    if (cached?.length) {
      setFacilities(cached);
      setLoading(false);
    }
    (async () => {
      try {
        // 첫 응답은 콜드 스타트라 느릴 수 있다 — 캐시가 있으면 짧게(웹 4초), 없으면 길게 기다린다.
        const items = await apiClient.get('/api/v1/infrastructures', {
          timeoutMs: cached?.length ? 4000 : 12000,
          params: {
            minLat: String(REGION.bounds.minLat),
            maxLat: String(REGION.bounds.maxLat),
            minLng: String(REGION.bounds.minLng),
            maxLng: String(REGION.bounds.maxLng),
          },
        });
        const mapped = mapInfrastructures(items);
        if (!active) return;
        setFacilities(mapped);
        writeCache(mapped);
        setLoading(false);
      } catch {
        if (!active) return;
        // 캐시가 이미 그려져 있으면 그대로 둔다 — 실패 화면은 보여 줄 것이 없을 때만.
        setError(!cached?.length);
        setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [nonce]);

  const loadEstimates = useCallback(async () => {
    try {
      const feed = await loadSharedCongestionEstimates();
      if (aliveRef.current) setEstimateById(estimatesFromFeed(feed));
    } catch { /* 404(구 서버)·타임아웃 — '추정 없음'. 직전 값은 그릴 때 60분 판정에 맡긴다 */ }
  }, []);

  useEffect(() => { void loadEstimates(); }, [loadEstimates]);
  usePolling(loadEstimates, ESTIMATE_POLL_MS);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { facilities, loading, error, reload, estimateById };
}
