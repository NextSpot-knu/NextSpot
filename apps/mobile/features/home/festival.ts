// 축제 자료 — 홈 축제 칩(필터·편의 시트)·랜딩 축제 배너(G1-05)·축제 시트가 같이 쓴다(ToolChips.tsx 에서 추출, 모양은 그대로).
// 웹 원본(0d145a1): apps/web/components/main/FestivalBanner.tsx — loadFestivalEvents · extractHomepageUrl · distanceLabel.
import { formatDistance, haversineMeters } from '@/lib/map/geo';
import { apiClient } from '~/lib/core/apiClient';

export interface FestivalEvent {
  contentId: string;
  title: string;
  startDate: string;
  endDate: string;
  address?: string | null;
  imageUrl?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  tel?: string | null;
  isOngoing: boolean;
  overview?: string | null;
  homepage?: string | null;
  playtime?: string | null;
  eventPlace?: string | null;
  usetimeFestival?: string | null;
  overviewI18n?: Record<string, string> | null;
}

const EVENTS_TTL_MS = 6 * 60 * 60 * 1000;
let eventsCache: { at: number; events: FestivalEvent[] } | null = null;
let eventsInflight: Promise<FestivalEvent[] | null> | null = null;

/** 화면당 한 번 — 여러 곳이 마운트돼도 같은 요청을 기다린다. 실패는 null('숨김'). */
export function loadFestivalEvents(): Promise<FestivalEvent[] | null> {
  if (eventsCache && Date.now() - eventsCache.at < EVENTS_TTL_MS) return Promise.resolve(eventsCache.events);
  if (eventsInflight) return eventsInflight;
  const request = (async () => {
    try {
      const res = await apiClient.get('/api/v1/events');
      if (res?.source !== 'tourapi' || !Array.isArray(res.events)) return null;
      eventsCache = { at: Date.now(), events: res.events as FestivalEvent[] };
      return eventsCache.events;
    } catch {
      return null;
    }
  })();
  eventsInflight = request;
  void request.finally(() => {
    if (eventsInflight === request) eventsInflight = null;
  });
  return request;
}

/** TourAPI homepage 원문은 URL 이거나 `<a href>` 조각 — 첫 http(s) URL 만 뽑는다. */
export function extractHomepageUrl(raw?: string | null): string | null {
  if (!raw) return null;
  return String(raw).match(/https?:\/\/[^\s"'<>]+/)?.[0] ?? null;
}

/** 현재 위치가 있고 좌표가 있을 때만 거리 글. */
export function festivalDistanceLabel(ev: FestivalEvent, location?: { lat: number; lng: number } | null): string | null {
  if (!location || ev.latitude == null || ev.longitude == null) return null;
  const m = haversineMeters(location.lat, location.lng, ev.latitude, ev.longitude);
  return Number.isFinite(m) ? formatDistance(m) : null;
}

/** 소개가 이 길이를 넘으면 '더보기'를 둔다(웹 OVERVIEW_CLAMP_THRESHOLD). */
export const OVERVIEW_CLAMP_THRESHOLD = 90;
