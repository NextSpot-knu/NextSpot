// 카카오맵으로 넘기는 주소 — 순수 함수(테스트: kakaoLinks.test.ts). 여는 일은 links.ts 가 한다.
//
// 웹 원본: apps/web/lib/navigation.ts(도보 = 목적지 지도 `map.kakao.com/link/map/…`, 차 = `map.kakao.com/link/to/…`),
// apps/web/components/RecommendationCard.tsx(장소 = `place.map.kakao.com/{id}`) — 기준 커밋 e07ea61.
// 웹 주소(https)는 그대로 둔다. 앱이 깔려 있으면 먼저 `kakaomap://` 로 연다.
//
// 앱 스킴 형식 — 카카오 공식 'Kakao Map URL Scheme' 문서(앱 6.0.0+, 조회 2026-11-02):
//   https://apis.map.kakao.com/ios_v2/docs/getting-started/urlscheme
//   - 좌표 보기:  kakaomap://look?p={위도},{경도}           (지도 가운데 + 표시)
//   - 장소:      kakaomap://place?id={카카오 장소 id}
//   - 길찾기:    kakaomap://route?sp={위도},{경도}&ep={위도},{경도}&by={car|publictransit|foot|bicycle}
//   문서에 없는 형태(출발지 sp 없는 route 등)는 쓰지 않는다 — 출발지를 모르면 아래처럼 대체한다.
// 웹 링크 형식 — 카카오 공식 Web 지도 가이드 'URL' 절: https://apis.map.kakao.com/web/guide/
//   /link/map/이름,위도,경도 · /link/to/이름,위도,경도
//
// 실기기 확인 전이다(계획 §6.1 '정확한 스킴 형식은 구현 때 실기기로 확인').

export interface KakaoDestination {
  name: string;
  latitude: number;
  longitude: number;
  /** 카카오 장소 id(숫자). 있으면 앱의 장소 화면으로 바로 연다. */
  kakaoPlaceId?: string | number | null;
}

export interface LatLng {
  latitude: number;
  longitude: number;
}

/** 앱 스킴 주소(없으면 웹으로만)와 웹 주소. */
export interface KakaoHandoff {
  app: string | null;
  web: string;
}

const KAKAO_PLACE_ID = /^\d{1,20}$/;

function validPoint(p: LatLng | null | undefined): p is LatLng {
  return !!p
    && Number.isFinite(p.latitude) && Number.isFinite(p.longitude)
    && Math.abs(p.latitude) <= 90 && Math.abs(p.longitude) <= 180;
}

function point(p: LatLng): string {
  return `${p.latitude},${p.longitude}`;
}

export function normalizeKakaoPlaceId(id: string | number | null | undefined): string | null {
  if (id == null) return null;
  const s = String(id).trim();
  return KAKAO_PLACE_ID.test(s) ? s : null;
}

/** 도보 — 웹과 같이 목적지 지도를 연다. 출발지를 알면 앱에서는 도보 길찾기(by=foot)로 바로 연다. */
export function kakaoWalkingHandoff(dest: KakaoDestination, origin?: LatLng | null): KakaoHandoff {
  // 좌표가 없으면(옛 저장 북마크 등) 이름 검색으로 — 웹 saved/page.tsx 와 같다. NaN 좌표 주소는 깨진 지도를 연다.
  if (!validPoint(dest)) return { app: null, web: `https://map.kakao.com/?q=${encodeURIComponent(dest.name)}` };
  const web = `https://map.kakao.com/link/map/${encodeURIComponent(dest.name)},${dest.latitude},${dest.longitude}`;
  if (validPoint(origin)) return { app: `kakaomap://route?sp=${point(origin)}&ep=${point(dest)}&by=foot`, web };
  const placeId = normalizeKakaoPlaceId(dest.kakaoPlaceId);
  if (placeId) return { app: `kakaomap://place?id=${placeId}`, web };
  return { app: `kakaomap://look?p=${point(dest)}`, web };
}

/**
 * 차 — 웹 `/link/to/` 는 현재 위치에서 출발하는 길찾기다. 앱 스킴의 route 는 문서상 출발지(sp)가 있어야 해서,
 * 출발지를 알 때만 앱으로 연다(by=car). 모르면 웹 주소만 — 카카오 모바일 웹이 앱 열기를 다시 제안한다.
 */
export function kakaoDrivingHandoff(dest: KakaoDestination, origin?: LatLng | null): KakaoHandoff {
  if (!validPoint(dest)) return { app: null, web: `https://map.kakao.com/?q=${encodeURIComponent(dest.name)}` };
  const web = `https://map.kakao.com/link/to/${encodeURIComponent(dest.name)},${dest.latitude},${dest.longitude}`;
  if (validPoint(dest) && validPoint(origin)) {
    return { app: `kakaomap://route?sp=${point(origin)}&ep=${point(dest)}&by=car`, web };
  }
  return { app: null, web };
}

/** 장소 상세 — 웹 `place.map.kakao.com/{id}`. id 가 숫자가 아니면 null. */
export function kakaoPlaceHandoff(id: string | number | null | undefined): KakaoHandoff | null {
  const placeId = normalizeKakaoPlaceId(id);
  if (!placeId) return null;
  return { app: `kakaomap://place?id=${placeId}`, web: `https://place.map.kakao.com/${placeId}` };
}
