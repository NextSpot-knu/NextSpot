// 지금 화면이 보고 있는 서비스 지역(리전) — 모듈 상태 한 칸.
//
// 왜 React 컨텍스트가 아니라 모듈 상태인가: 이 값을 읽는 쪽(api-client 의 request() · usageEvents · analytics)은
// 훅이 아니라 평범한 함수다. 컨텍스트로 두면 그 파일들이 React·regionContext 를 import 해야 하고, regionContext 가
// 다시 api-client 를 import 하므로 순환이 생긴다. 값을 쓰는 곳은 lib/regionContext.tsx 의 RegionProvider 하나뿐이다.
//
// 기본값은 공개 지역(경주)이다. 프로바이더가 없거나(관제·콘솔 테스트) 아직 정하지 못했을 때도 경주로 동작한다 —
// 내부 지역은 서버가 역할을 확인해 준 다음에만 켜진다(lib/regionState.ts).

/** 모든 사용자에게 공개된 지역. 서버 app/core/region.py 의 PUBLIC_REGION 과 같은 값이다. */
export const PUBLIC_REGION_ID = 'gyeongju';

let activeRegion: string = PUBLIC_REGION_ID;

/** 지금 화면이 보고 있는 지역 id. 정하지 않았으면 공개 지역. */
export function getActiveRegion(): string {
  return activeRegion;
}

/** 지역을 바꾼다. 빈 값은 공개 지역으로 돌린다. RegionProvider 만 부른다. */
export function setActiveRegion(id: string | null | undefined): void {
  activeRegion = typeof id === 'string' && id.trim() ? id.trim() : PUBLIC_REGION_ID;
}

/** 공개 지역인가(빈 값도 공개 지역으로 본다). */
export function isPublicRegion(id: string | null | undefined): boolean {
  return !id || id === PUBLIC_REGION_ID;
}
