// 대기 보드 카드를 누르면 열리는 /explore/recommend 의 주소 — 웹 apps/web/lib/recommendOrigin.ts 의 buildRecommendHref 를
// 옮겼다(웹 모듈은 regionPacks·congestionEstimate→api-client 를 끌고 와 check:shared 에 걸린다). 쿼리 이름·값은 웹과 같다:
// facilityId(없으면 name) · lat · lng · type · from=waiting(좌표를 알 때만). 앱 v1 은 경주만이라 좌표를 모르면 경주 중심.
import { REGION } from '@/lib/region';

export interface RecommendOriginRow {
  facilityId?: string | null;
  name?: string | null;
  type: string;
  latitude?: number | null;
  longitude?: number | null;
}

function validPoint(lat: unknown, lng: unknown): boolean {
  return typeof lat === 'number' && Number.isFinite(lat) && typeof lng === 'number' && Number.isFinite(lng);
}

/** expo-router push 에 줄 { pathname, params }. params 값은 전부 문자열. */
export function buildRecommendRoute(row: RecommendOriginRow): {
  pathname: '/explore/recommend';
  params: Record<string, string>;
} {
  const placeKnown = validPoint(row.latitude, row.longitude);
  const lat = placeKnown ? (row.latitude as number) : REGION.center.lat;
  const lng = placeKnown ? (row.longitude as number) : REGION.center.lng;
  const params: Record<string, string> = {};
  if (row.facilityId) params.facilityId = row.facilityId;
  else if (row.name) params.name = row.name;
  params.lat = String(lat);
  params.lng = String(lng);
  params.type = row.type;
  // 좌표를 모르는(옛 캐시) 행은 지역 중심에서 잰 값이라 '그 장소에서 걷는다'고 말할 수 없다.
  if (placeKnown) params.from = 'waiting';
  return { pathname: '/explore/recommend', params };
}
