import { createPublicClient } from "./supabase";
const supabase = createPublicClient();

// 헬퍼: snake_case -> camelCase
function snakeToCamel(s: string): string {
  return s.replace(/(_\w)/g, (k) => k[1].toUpperCase());
}

// 헬퍼: camelCase -> snake_case
function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

// 재귀적으로 객체 키를 camelCase로 변환
export function keysToCamel(o: any): any {
  if (o === null || o === undefined) return o;
  if (Array.isArray(o)) {
    return o.map(keysToCamel);
  }
  if (typeof o === "object") {
    const n: { [key: string]: any } = {};
    Object.keys(o).forEach((k) => {
      n[snakeToCamel(k)] = keysToCamel(o[k]);
    });
    return n;
  }
  return o;
}

// 재귀적으로 객체 키를 snake_case로 변환
export function keysToSnake(o: any): any {
  if (o === null || o === undefined) return o;
  if (Array.isArray(o)) {
    return o.map(keysToSnake);
  }
  if (typeof o === "object") {
    const n: { [key: string]: any } = {};
    Object.keys(o).forEach((k) => {
      n[camelToSnake(k)] = keysToSnake(o[k]);
    });
    return n;
  }
  return o;
}

// 로컬 전용: FastAPI 백엔드 직접 호출(기본 http://localhost:8000). 대회용 API Gateway 경유는 제거됨.
const BASE_URL = process.env.NEXT_PUBLIC_FASTAPI_URL || "http://localhost:8000";

interface RequestOptions extends RequestInit {
  params?: Record<string, string>;
}

async function request(path: string, options: RequestOptions = {}) {
  // 1. Supabase JWT 토큰 추출
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;

  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  if (token) {
    // 로컬/직접 호출에서는 Authorization 을 읽는다. API Gateway 경유(프로덕션)에서는 게이트웨이가
    // Authorization 을 백엔드 인증용 OIDC 로 덮어쓰므로, Supabase JWT 를 X-Supabase-Authorization
    // 로도 실어 보낸다(백엔드 get_current_user 가 X-(Forwarded|Supabase)-Authorization 을 우선 확인).
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("X-Supabase-Authorization", `Bearer ${token}`);
  }

  // query parameter 처리
  // query parameter 처리
  let url = `${BASE_URL}${path}`;
  if (options.params) {
    const queryParams = new URLSearchParams(keysToSnake(options.params));
    url += `?${queryParams.toString()}`;
  }

  // body가 존재하는 경우 camelCase -> snake_case 변환 후 전송
  let body = options.body;
  if (body && typeof body === "object" && !(body instanceof FormData)) {
    body = JSON.stringify(keysToSnake(body));
  }

  const response = await fetch(url, {
    ...options,
    headers,
    body,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.detail || `HTTP error! status: ${response.status}`);
  }

  // 응답 데이터 json 파싱 및 snake_case -> camelCase 변환
  const data = await response.json();
  return keysToCamel(data);
}

export const apiClient = {
  get: (path: string, options?: Omit<RequestOptions, "method" | "body">) => 
    request(path, { ...options, method: "GET" }),
  
  post: (path: string, body?: any, options?: Omit<RequestOptions, "method" | "body">) => 
    request(path, { ...options, method: "POST", body }),
  
  put: (path: string, body?: any, options?: Omit<RequestOptions, "method" | "body">) => 
    request(path, { ...options, method: "PUT", body }),
  
  delete: (path: string, options?: Omit<RequestOptions, "method" | "body">) => 
    request(path, { ...options, method: "DELETE" }),
};

// --- TTTV 추천 엔진 연동 API 함수 ---

export interface RecommendationResponse {
  recommendationId: string;
  facility: {
    id: string;
    name: string;
    type: string;
    latitude: number;
    longitude: number;
    capacity: number;
    operatingHours?: any;
    features?: any;
    currentCount?: number;
    congestionLevel?: number;
  };
  tttvScore: number;
  breakdown: {
    preference: number;
    waitTime: number;
    travelTime: number;
    incentive: number;
  };
  distanceM: number;
  reason?: string; // WP3: Gemini 생성 추천 사유 (백엔드 snake_case reason → camel reason)
  rank: number;
  totalCandidates: number;
}

export async function getRecommendations(
  originalFacilityId: string,
  userLocation: { lat: number; lng: number }
): Promise<RecommendationResponse[]> {
  // Supabase 세션에서 현재 로그인한 유저 ID 획득
  const { data: { session } } = await supabase.auth.getSession();
  let userId = session?.user?.id;
  
  if (!userId) {
    console.warn("인증 세션이 없습니다. 데모용 모의 사용자 ID(GYEONGJU-VISITOR-01)를 사용합니다.");
    userId = "a2222222-2222-2222-2222-222222222222";
  }

  return apiClient.post("/api/v1/recommendations", {
    userId,
    originalFacilityId,
    userLat: userLocation.lat,
    userLng: userLocation.lng
  });
}

export async function submitFeedback(
  recommendationId: string,
  action: "accepted" | "rejected" | "ignored"
): Promise<{ success: boolean; updatedVector: boolean }> {
  return apiClient.post("/api/v1/feedback", {
    recommendationId,
    action
  });
}

/**
 * 타입별(음식점/카페/관광지/문화시설) 추천 랭킹 — 메인 지도 브라우즈용.
 * 백엔드가 사용자 선호 벡터·실시간 혼잡·거리로 TTTV 점수를 매기고 상위 N개에 Gemini 사유를 붙여 반환.
 * (/recommendations 가 '혼잡한 원본의 대안'을 주는 것과 달리, 원본 없이 타입 전체를 랭킹한다.)
 */
export async function recommendByType(
  facilityType: string,
  userLocation: { lat: number; lng: number },
  excludeIds: string[] = [],
  limit = 5
): Promise<RecommendationResponse[]> {
  const { data: { session } } = await supabase.auth.getSession();
  let userId = session?.user?.id;
  if (!userId) {
    console.warn("인증 세션이 없습니다. 데모용 모의 사용자 ID(GYEONGJU-VISITOR-01)를 사용합니다.");
    userId = "a2222222-2222-2222-2222-222222222222";
  }
  return apiClient.post("/api/v1/recommendations/by-type", {
    userId,
    facilityType,
    userLat: userLocation.lat,
    userLng: userLocation.lng,
    excludeIds,
    limit
  });
}

// --- 자연어 선호 입력 (Gemini 파싱 → 추천 반영) ---

export interface ParsePreferenceResult {
  preferredCategories: string[];
  attributes: string[];
  summary: string;       // 'AI가 이렇게 이해했어요' 한국어 문장
  isFallback: boolean;   // Gemini 미사용/실패로 키워드 규칙을 썼는지
  vectorUpdated: boolean;
  categoriesSaved: boolean;
}

/**
 * 사용자가 자연어로 말한/적은 선호를 백엔드로 보내 구조화하고,
 * 선호 벡터와 preferred_categories 에 즉시 반영한다.
 */
export async function parsePreference(text: string): Promise<ParsePreferenceResult> {
  return apiClient.post("/api/v1/preferences/parse", { text });
}

// --- 음성 비서 1턴 해석 (Vertex Gemini) ---

export interface VoiceTurnCandidate {
  id: string;
  name: string;
  cuisine?: string[] | string | null; // 음식 종류(한식/분식/카페·디저트 등) — 메뉴/종류 매칭용
  congestion?: number; // 0~1
  distanceM?: number;
}

export interface VoiceTurnResult {
  action: string; // accept|next|reject|details|select|filter|stop|unknown
  targetFacilityId: string | null;
  matchIds: string[]; // filter 일 때 선호에 맞는 후보 id들('양식'→양식 식당들)
  spoken: string | null; // Gemini 생성 한국어 응답(없으면 프런트 자체 멘트)
}

/**
 * 음성 비서가 추천을 안내한 뒤 사용자의 자유발화 응답을 백엔드(Vertex Gemini)로 보내
 * 의도(accept/next/reject/details/select/stop)를 분류하고, 선호 표현이면 후보 중 가장 맞는
 * 시설(targetFacilityId)을 고르며, 한국어 응답(spoken)을 생성한다. 무인증 엔드포인트.
 */
export async function voiceTurn(
  utterance: string,
  facilityType: string,
  currentName: string | null,
  candidates: VoiceTurnCandidate[]
): Promise<VoiceTurnResult> {
  return apiClient.post("/api/v1/voice/turn", {
    utterance,
    facilityType,
    currentName,
    candidates,
  });
}
