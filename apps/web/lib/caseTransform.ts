// API 응답/요청 키 변환 — 의존성 없는 순수 함수.
//
// **이 레포에서 프런트가 보는 API 응답은 언제나 camelCase 다.** 서버(FastAPI)는 snake_case 로
// 내려주지만 `lib/api-client.ts` 의 `request()` 가 마지막에 `keysToCamel()` 을 통과시킨다.
// 요청 본문·쿼리는 반대로 `keysToSnake()` 를 거쳐 나간다.
//
// 그래서 화면 코드는 `data.ownedFacilities` 처럼 camelCase 로 읽는 게 **맞다**.
// 서버 응답을 curl 로 찍어 보고 snake_case 라고 프런트를 고치면 오히려 망가진다 —
// 실제로 그렇게 한 적이 있다(2026-08-28). 경계는 raw HTTP 응답이 아니라 apiClient 의 출력이다.
//
// api-client.ts 안에 있던 것을 여기로 뺐다. 그 파일은 supabase 클라이언트를 끌고 오므로
// import 만 해도 무거워서 **레포 전체 계약의 핵심인 이 변환에 테스트를 붙일 수 없었다.**

/** `snake_case` → `camelCase` */
export function snakeToCamel(s: string): string {
  return s.replace(/(_\w)/g, (k) => k[1].toUpperCase());
}

/** `camelCase` → `snake_case` */
export function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

// 입력은 임의 JSON(unknown). 반환은 any 유지 — request() 의 추론 반환형(Promise<any>)이
// 레포 전역의 apiClient.get/post 소비처(res.predictions, data.vector 등) 계약이기 때문.
/** 객체 키를 재귀적으로 camelCase 로 바꾼다(응답 방향). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function keysToCamel(o: unknown): any {
  if (o === null || o === undefined) return o;
  if (Array.isArray(o)) {
    return o.map(keysToCamel);
  }
  if (typeof o === "object") {
    const n: Record<string, unknown> = {};
    Object.keys(o).forEach((k) => {
      n[snakeToCamel(k)] = keysToCamel((o as Record<string, unknown>)[k]);
    });
    return n;
  }
  return o;
}

/** 객체 키를 재귀적으로 snake_case 로 바꾼다(요청 방향). */
export function keysToSnake(o: unknown): unknown {
  if (o === null || o === undefined) return o;
  if (Array.isArray(o)) {
    return o.map(keysToSnake);
  }
  if (typeof o === "object") {
    const n: Record<string, unknown> = {};
    Object.keys(o).forEach((k) => {
      n[camelToSnake(k)] = keysToSnake((o as Record<string, unknown>)[k]);
    });
    return n;
  }
  return o;
}
