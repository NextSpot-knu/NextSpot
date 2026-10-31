// 지역 요청 헤더 — 공개 지역(경주)에서는 아무 헤더도 붙이지 않는다.
//
// 경주 요청이 오늘과 바이트 단위로 같아야 한다: 헤더 하나만 늘어도 CORS 사전 요청(preflight)이 생기고 서버 캐시·로그
// 모양이 달라진다. 그래서 경주는 빈 객체를 돌려주고, request() 는 그 빈 객체를 합치므로 아무것도 바뀌지 않는다.
//
// 이 헤더는 권한이 아니다. 서버(app/core/region.py resolve_request_region)는 헤더를 믿지 않고 매 요청 DB 역할로 다시
// 판정한다 — 권한 없는 계정이 헤더를 보내면 조용히 경주로 내려간다.
import { PUBLIC_REGION_ID } from './regionRuntime';

/** 서버 app/core/region.py 의 REGION_HEADER 와 같은 이름. */
export const REGION_HEADER = 'X-NextSpot-Region';

// 서버가 내려준 지역 id 만 실어 보낸다 — 이상한 값(공백·제어문자·긴 문자열)은 헤더로 만들지 않는다.
const REGION_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/** 요청에 합칠 지역 헤더. 공개 지역·빈 값·형식이 틀린 값은 {}. */
export function regionRequestHeaders(id: string | null | undefined): Record<string, string> {
  if (!id || id === PUBLIC_REGION_ID || !REGION_ID_PATTERN.test(id)) return {};
  return { [REGION_HEADER]: id };
}
