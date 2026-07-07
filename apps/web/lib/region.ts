// 서비스 지역(리전) 단일 설정 — 다지역 확장성의 단일 소스.
//
// 새 지역(예: 전주 한옥마을, 부산 감천문화마을) 확장 시 이 파일과 apps/api .env 의
// 기준좌표만 교체하면 된다 — 코드 전반의 좌표 하드코딩 없음.
// (지도 기본 중심/지오펜스/데모 위치 프리셋이 모두 여기서 나온다.
//  랜드마크 목록은 lib/landmarks.ts 가 같은 지역팩의 일부로 함께 교체 대상.)
export const REGION = {
  id: "gyeongju-hwangnidan",
  name: "경주 황리단길",
  /** 지도/추천 기본 중심점 (황리단길 중심) */
  center: { lat: 35.8362, lng: 129.2095 },
  /** 서비스 경계(지오펜스) — 이 범위를 벗어난 위치는 center 로 모킹한다 */
  bounds: { minLat: 35.82, maxLat: 35.85, minLng: 129.19, maxLng: 129.24 },
  /** 데모 위치 프리셋 (main 위치 모킹 사이드바) */
  presets: [
    { id: 1, name: '황리단길', lat: 35.8362, lng: 129.2095 },
    { id: 2, name: '대릉원', lat: 35.8389, lng: 129.2099 },
    { id: 3, name: '첨성대', lat: 35.8347, lng: 129.2189 },
    { id: 4, name: '동궁과 월지', lat: 35.8348, lng: 129.2265 },
    { id: 5, name: '황남빵 본점', lat: 35.8389, lng: 129.2117 },
    { id: 6, name: '교촌마을', lat: 35.8296, lng: 129.2156 },
  ],
} as const;

/** 좌표가 서비스 지역(지오펜스) 안인지 판정 — 기존 isWithinGyeongju 인라인 판정과 동일 로직 */
export function isWithinRegion(lat: number, lng: number): boolean {
  const { minLat, maxLat, minLng, maxLng } = REGION.bounds;
  return lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng;
}
