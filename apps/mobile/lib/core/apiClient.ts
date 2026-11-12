// FastAPI(/api/v1/*) 클라이언트 — 웹 apps/web/lib/api-client.ts 의 앱판(기준 커밋 e07ea61).
//
// 이름·시그니처는 웹과 같게 두어 화면 이식이 웹 호출부를 그대로 따라 쓸 수 있게 했다. 요청 엔진·오류 타입은
// httpCore.ts(순수 — 테스트 대상)에 있고, 여기서는 앱의 Supabase 세션·Platform.OS·env 에 묶고 엔드포인트를 둔다.
//
// 웹과 다른 것:
//   · 모든 요청에 X-NextSpot-Client: ios|android(httpCore 참고). 지역 헤더는 싣지 않는다 — 앱 v1 은 경주만.
//   · window CustomEvent('nextspot:llm-debug') → appEvents.emit('llm-debug')(lib/core/events.ts).
//   · 옮기지 않은 것: 내부 지역(S3) 조회·setApiRegion(개발자 전용 서울), 가정 시각 시뮬레이터(M14 — v1 제외),
//     prefetchDemoHotPaths(심사 데모용 캐시 데우기). 필요해지면 웹 원본에서 옮긴다.
import { Platform } from 'react-native';
import type { Locale } from '@/lib/i18n/config';
import { uniqueSyntheticRecommendationIds } from '@/lib/recommendationIds';
import { ttlPromiseCache } from '@/lib/ttlPromiseCache';

import { ensureAnonymousSession } from './anonymousSession';
import { env } from './env';
import { appEvents, type LlmDebugDetail } from './events';
import {
  AuthError,
  CLIENT_HEADER,
  clientPlatformFrom,
  createRequester,
  httpStatus,
  type RequestOptions,
} from './httpCore';
import {
  asksForStroller,
  keepStrollerFriendly,
  markServerSkipsStroller,
  serverSkipsStroller,
  withoutStrollerContext,
} from './strollerSupport';
import { createPublicClient } from './supabase';
import type { PlaceCategory, TravelContext, VoiceAppCommand } from './travelContextTypes';

export {
  AuthError,
  HttpError,
  RequestTimeoutError,
  ServiceUnavailableError,
  errorMessageFrom,
  httpStatus,
  isAuthError,
  isRequestTimeout,
  isServiceUnavailable,
  type RequestOptions,
} from './httpCore';
export type { PlaceCategory, TravelContext, VoiceAppCommand } from './travelContextTypes';

const platform = clientPlatformFrom(Platform.OS);

const request = createRequester({
  baseUrl: env.apiUrl,
  fetch: (input, init) => fetch(input, init),
  getAccessToken: async () => {
    const { data: { session } } = await createPublicClient().auth.getSession();
    return session?.access_token ?? null;
  },
  platform,
});

function emitLlmDebug(detail: LlmDebugDetail): void {
  appEvents.emit('llm-debug', detail);
}

/** 백엔드 캐시 워밍 — 발사 후 망각. 실패는 전부 무시한다. */
export function warmBackend(): void {
  try {
    const headers: Record<string, string> = platform ? { [CLIENT_HEADER]: platform } : {};
    void fetch(`${env.apiUrl}/api/v1/warmup`, { method: 'GET', headers }).catch(() => {});
  } catch { /* 무시 */ }
}

// D5: TourAPI 마지막 동기화 신선도 — GET /api/v1/freshness.
export interface FreshnessResponse {
  lastTourapiSync: string | null;
  source: 'event' | 'estimate' | null;
  written: number | null;
}

type MethodOptions = Omit<RequestOptions, 'method' | 'body'>;

export const apiClient = {
  get: (path: string, options?: MethodOptions) => request(path, { ...options, method: 'GET' }),
  post: (path: string, body?: unknown, options?: MethodOptions) => request(path, { ...options, method: 'POST', body }),
  patch: (path: string, body?: unknown, options?: MethodOptions) => request(path, { ...options, method: 'PATCH', body }),
  delete: (path: string, options?: MethodOptions) => request(path, { ...options, method: 'DELETE' }),
  getFreshness: (): Promise<FreshnessResponse> => request('/api/v1/freshness', { method: 'GET' }),
};

/**
 * 여행 조건을 실어 POST — 유모차 조건을 모르는 옛 API 가 422 를 주면 빼고 한 번만 다시 보낸다(웹과 같다).
 * strollerDropped 가 true 면 호출부가 keepStrollerFriendly 로 직접 거른다.
 */
export async function postWithTravelContext<T>(
  path: string,
  body: Record<string, unknown> & { context?: unknown },
  options?: MethodOptions,
): Promise<{ data: T; strollerDropped: boolean }> {
  const asked = asksForStroller(body.context);
  if (asked && serverSkipsStroller()) {
    return { data: await apiClient.post(path, withoutStrollerContext(body), options), strollerDropped: true };
  }
  try {
    return { data: await apiClient.post(path, body, options), strollerDropped: false };
  } catch (err) {
    if (!asked || httpStatus(err) !== 422) throw err;
    let data: T;
    try {
      data = await apiClient.post(path, withoutStrollerContext(body), options);
    } catch (retryErr) {
      throw httpStatus(retryErr) === 422 ? err : retryErr;
    }
    markServerSkipsStroller();
    return { data, strollerDropped: true };
  }
}

/** 영업 근거가 약한 등급으로 채워 달라고 청할지 — 요청 종류가 전부 음식점·카페일 때만(웹 주석 참고). */
export function fillsWeakerTiersFor(types: readonly string[]): boolean {
  return types.length > 0 && types.every((type) => type === 'restaurant' || type === 'cafe');
}

export async function mergeGuestData(guestToken: string): Promise<void> {
  await apiClient.post('/api/v1/account/merge-guest', { guestToken });
}

export async function deleteMyAccount(): Promise<void> {
  await apiClient.delete('/api/v1/account/me');
}

// --- 혼잡 추정(공개 피드) ---

export interface CongestionEstimate {
  level: number;
  source: 'estimated';
  observedAt: string | null;
  parkingLevel: number;
  tourismLevel: number | null;
  lotCount: number;
  nearestLotM: number | null;
  radiusM: number;
  rawLevel?: number | null;
  calibrated?: boolean | null;
  calibrationBasis?: string | null;
}

export interface CongestionEstimatesResponse {
  available: boolean;
  reason: string | null;
  observedAt: string | null;
  radiusM: number | null;
  lotCount: number;
  estimates: Record<string, CongestionEstimate>;
}

export async function getCongestionEstimates(
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<CongestionEstimatesResponse> {
  return apiClient.get('/api/v1/congestion/estimates', {
    timeoutMs: options?.timeoutMs ?? 8000,
    signal: options?.signal,
  });
}

/** 화면들이 나눠 쓰는 추정 피드 — 4분 동안 한 번만 묻는다. 실패는 담아 두지 않는다. */
export const loadSharedCongestionEstimates: () => Promise<CongestionEstimatesResponse> = ttlPromiseCache(
  () => getCongestionEstimates({ timeoutMs: 8000 }),
  4 * 60 * 1000,
);

// --- 혼잡 예측(🔮 예측 띠 — H2b) ---
// 웹 /main 은 이 호출들을 page.tsx·lib/predictModel.ts·lib/areaDemandCurve.ts 에서 apiClient.get/post 로 직접 부른다. 앱은 모양을
// 여기 한 곳에 적는다(응답 모델: apps/api/app/routers/predict.py · area_demand.py). 모두 읽기다 — /predict/batch 는 POST 지만 쓰지 않는다.
// 주의: predict 라우터는 /api/v1 이 아닌 /predict 아래에 있다(main.py 프리픽스).

/** GET /predict/model-info 의 일부. */
export interface PredictModelInfo {
  trained: boolean;
  /** 미학습 시 서버 폴백 이름(예: "degraded_rules"). */
  fallbackState: string | null;
}

/** 모델 학습 여부를 묻는다. 모양이 어긋나거나 못 물었으면 null(웹 parsePredictModelInfo·fetchPredictModelInfo). */
export async function getPredictModelInfo(): Promise<PredictModelInfo | null> {
  try {
    const body: { trained?: unknown; fallbackState?: unknown } | null = await apiClient.get('/predict/model-info', {
      timeoutMs: 4000,
    });
    if (!body || typeof body.trained !== 'boolean') return null;
    return { trained: body.trained, fallbackState: typeof body.fallbackState === 'string' ? body.fallbackState : null };
  } catch {
    return null;
  }
}

let predictTrainedPending: Promise<boolean> | null = null;

/**
 * 예측 모델이 학습돼 있으면 true — 앱 실행마다 한 번만 묻는다(웹 isPredictModelTrained 는 세션 저장). 미학습이면 /predict/batch 는
 * 언제나 503 이라 부르지 않는다. 못 물었으면 false 로 보되 기억하지 않는다(다음에 다시 묻는다).
 */
export function isPredictModelTrained(): Promise<boolean> {
  if (predictTrainedPending) return predictTrainedPending;
  const pending = getPredictModelInfo().then((info) => {
    if (!info) predictTrainedPending = null;
    return info?.trained === true;
  });
  predictTrainedPending = pending;
  return pending;
}

export interface BatchPredictionItem {
  facilityId: string;
  predictedCongestion: number;
  /** 실측에 앵커된 예측인가. false 면 화면은 '추정' 을 붙인다. */
  anchored?: boolean;
  eventBoost?: number;
}

export interface BatchPredictResponse {
  generatedAt: string;
  hoursAhead: number;
  predictions: BatchPredictionItem[];
}

/** POST /predict/batch — 지금 + hoursAhead 시간의 장소별 혼잡 예측(읽기). 실패는 throw. */
export async function predictBatch(hoursAhead: number, options?: { signal?: AbortSignal }): Promise<BatchPredictResponse> {
  return apiClient.post('/predict/batch', { hoursAhead }, { signal: options?.signal });
}

export interface AreaDemandForecastResponse {
  available?: boolean;
  forecast?: { level?: number | null } | null;
}

/** GET /api/v1/area-demand/forecast — 한 도착 시각의 권역 수요 전망(서버 창: 지금+30분~+6시간). 전송 실패는 throw. */
export async function getAreaDemandForecast(
  point: { lat: number; lng: number },
  arrivalAt: Date,
  options?: { signal?: AbortSignal },
): Promise<AreaDemandForecastResponse> {
  return apiClient.get('/api/v1/area-demand/forecast', {
    params: { lat: String(point.lat), lng: String(point.lng), arrivalAt: arrivalAt.toISOString() },
    timeoutMs: 8000,
    signal: options?.signal,
    noRetry: true,
  });
}

// --- 공영주차장(주차장 탭 — H2b) ---

/** GET /api/v1/area-demand/parking-lots 항목(area_demand.py ParkingLotItem). */
export interface ParkingLotItem {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  distanceM: number;
  totalSpaces: number | null;
  availableSpaces: number | null;
  occupancy: number | null;
  live: boolean;
  observedAt: string | null;
  source: string | null;
}

export interface ParkingLotsResponse {
  available: boolean;
  state: string;
  source: string | null;
  radiusM: number;
  observedAt: string | null;
  lots: ParkingLotItem[];
}

/** 경주시 ITS 공식 위치·실시간 잔여면(공개 GET). 웹 /main 주차장 탭과 같은 반경 5km·6초. 실패는 throw. */
export async function getParkingLots(
  point: { lat: number; lng: number },
  options?: { radiusM?: number; signal?: AbortSignal },
): Promise<ParkingLotsResponse> {
  return apiClient.get('/api/v1/area-demand/parking-lots', {
    params: { lat: String(point.lat), lng: String(point.lng), radiusM: String(options?.radiusM ?? 5000) },
    timeoutMs: 6000,
    signal: options?.signal,
  });
}

// --- 추천 ---

export interface RecommendationResponse {
  recommendationId: string;
  facility: {
    id: string;
    name: string;
    type: string;
    latitude: number;
    longitude: number;
    capacity: number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    operatingHours?: { open?: string; closed?: string; [key: string]: any } | null;
    features?: Record<string, unknown> | null;
    imageUrl?: string | null;
    galleryImages?: string[] | null;
    address?: string | null;
    phone?: string | null;
    homepage?: string | null;
    overview?: string | null;
    barrierFree?: boolean | null;
    currentCount?: number | null;
    congestionLevel?: number;
    timesaleRate?: number | null;
    seatStatusFresh?: { level: 'low' | 'mid' | 'full'; minutesAgo: number } | null;
    couponRate?: number | null;
    placeDataSource?: string | null;
    dataUpdatedAt?: string | null;
    availabilityEvidence?: {
      status: 'open' | 'closed';
      evidenceTier: 'single_report' | 'corroborated';
      corroboratingCount: number;
      reportedAt: string;
      expiresAt: string;
    } | null;
  };
  spotScore: number;
  breakdown: {
    preference: number;
    waitTime?: number | null;
    travelTime: number;
    travelSource?: 'osm_pedestrian' | 'estimated';
    incentive: number;
    rankingWaitTime?: number | null;
    eventBoost?: number;
    eventTitle?: string | null;
    areaDemandLevel?: number | null;
    areaDemandMode?: 'live' | 'forecast' | 'statistical' | 'contextual' | null;
    areaDemandSources?: ('parking' | 'parking_history' | 'tourism' | 'festival' | 'weather')[];
    areaDemandObservedAt?: string | null;
    areaDemandRadiusM?: number | null;
    areaDemandParkingEvidence?: {
      level: number;
      mode: 'live' | 'forecast';
      observedAt?: string | null;
      radiusM?: number | null;
    } | null;
    areaDemandTourismEvidence?: {
      referenceName?: string | null;
      distanceM?: number | null;
      forecastDate?: string | null;
      relativeIndex?: number | null;
    } | null;
    areaDemandPenaltyMinutes?: number;
    areaDemandConfidence?: 'high' | 'medium' | 'low' | 'none';
    areaDemandRank?: number | null;
    areaDemandComparableCount?: number;
    areaDemandPercentile?: number | null;
    areaDemandDeltaVsMedian?: number | null;
    areaDemandDistinguishable?: boolean;
    delayedAreaDemandLevel?: number | null;
    delayedAreaDemandMode?: 'forecast' | 'statistical' | null;
    arrivalAction?: 'go_now' | 'wait_then_go' | 'choose_calmer' | 'no_clear_advantage';
    recommendedDepartureDelayMinutes?: number | null;
    tourapiRelatedRank?: number | null;
    tourapiRelatedPrior?: number | null;
    discoveryThemeMatch?: {
      source: 'tourapi_related' | 'facility_fact';
      value: string;
    } | null;
  };
  distanceM: number;
  reason?: string;
  reasonSource?: 'llm' | 'template';
  congestionLevel?: number | null;
  congestionSource?: 'measured' | 'predicted' | 'none';
  congestionPredictionBasis?: 'model' | 'industry_baseline' | null;
  congestionLogSource?: string | null;
  congestionIsStale?: boolean | null;
  congestionTimestamp?: string | null;
  congestionIsCurrent?: boolean | null;
  congestionEstimate?: CongestionEstimate | null;
  rank: number;
  totalCandidates: number;
  openStatusAtArrival?: 'open_expected' | 'closing_soon' | 'closed_confirmed' | 'needs_confirmation';
  informationConfidence?: 'verified' | 'unknown';
  eligibilityTier?:
    | 'verified_open_route'
    | 'verified_open_estimated_route'
    | 'hours_confirmation_required_route'
    | 'hours_and_route_confirmation_required';
  placeDataSource?: string | null;
  dataUpdatedAt?: string | null;
  scoringMode: 'model' | 'measured_rules' | 'area_stats_rules' | 'degraded_rules';
  modelVersion?: string | null;
  predictionSource: 'registry' | 'measured' | 'unavailable';
}

export interface AvailabilityReportResult {
  success: boolean;
  facilityId: string;
  status: 'open' | 'closed';
  evidenceTier: 'single_report' | 'corroborated';
  corroboratingCount: number;
  reportedAt: string;
  expiresAt: string;
}

export async function reportFacilityAvailability(
  facilityId: string,
  status: 'open' | 'closed',
): Promise<AvailabilityReportResult> {
  return apiClient.post('/api/v1/reports/availability', { facilityId, status });
}

function emitReasonSourceDebug(items: RecommendationResponse[]): void {
  let llmCount = 0;
  let templateCount = 0;
  let seen = false;
  for (const item of items) {
    if (item.reasonSource === 'llm') {
      llmCount++;
      seen = true;
    } else if (item.reasonSource === 'template') {
      templateCount++;
      seen = true;
    }
  }
  if (seen) emitLlmDebug({ feature: 'reason', llmCount, templateCount });
}

export async function getRecommendations(
  originalFacilityId: string,
  userLocation: { lat: number; lng: number },
  context?: TravelContext,
  options?: {
    preferenceIntent?: string | null;
    candidateTypes?: ('restaurant' | 'cafe' | 'attraction' | 'culture')[];
    discoveryTheme?: 'silla_core' | 'night_heritage' | 'hanok_cafe' | 'indoor_history' | 'gyochon_walk';
    signal?: AbortSignal;
  },
): Promise<RecommendationResponse[]> {
  const session = await ensureAnonymousSession();
  const userId = session?.user?.id;
  if (!userId) throw new AuthError();

  const body = {
    userId,
    originalFacilityId,
    userLat: userLocation.lat,
    userLng: userLocation.lng,
    context,
    preferenceIntent: options?.preferenceIntent ?? null,
    candidateTypes: options?.candidateTypes ?? [],
    discoveryTheme: options?.discoveryTheme ?? null,
    fillWeakerTiers: fillsWeakerTiersFor(options?.candidateTypes ?? []),
  };
  // 45초 — 콜드 백엔드에서 기본 10초를 넘긴다(웹 2026-09-21 재현).
  const reqOpts = { signal: options?.signal, timeoutMs: 45000 };
  const send = () => postWithTravelContext<RecommendationResponse[]>('/api/v1/recommendations', body, reqOpts);
  let result: { data: RecommendationResponse[]; strollerDropped: boolean };
  try {
    result = await send();
  } catch (err) {
    const st = httpStatus(err);
    // 콜드/재시작 직후 일시 503·429 — 2초 뒤 딱 한 번 조용히 재시도. 호출자 취소 시 제외.
    if ((st === 503 || st === 429) && !options?.signal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      result = await send();
    } else {
      throw err;
    }
  }
  const res = result.strollerDropped ? keepStrollerFriendly(result.data) : result.data;
  emitReasonSourceDebug(res);
  return uniqueSyntheticRecommendationIds(res);
}

export type FeedbackAction =
  | 'accepted_visit_intent'
  | 'rejected'
  | 'skipped'
  | 'dismissed_batch'
  | 'unsaved'
  | 'helpful'
  | 'not_helpful';

export async function submitFeedback(
  recommendationId: string,
  action: FeedbackAction,
): Promise<{ success: boolean; updatedVector: boolean }> {
  return apiClient.post('/api/v1/feedback', { recommendationId, action });
}

export type RecommendationQuestion = 'why_first' | 'difference' | 'family_check';
export interface RecommendationExplanation {
  answer: string;
  sourceLabels: string[];
  llmStatus: string;
}

export async function explainRecommendation(
  recommendationId: string,
  question: RecommendationQuestion,
  comparisonRecommendationIds: string[] = [],
  locale: Locale = 'ko',
): Promise<RecommendationExplanation> {
  return apiClient.post(`/api/v1/recommendations/${recommendationId}/explain`, {
    question,
    comparisonRecommendationIds: comparisonRecommendationIds.slice(0, 2),
    locale,
  });
}

export async function rejectRecommendation(
  facilityId: string,
): Promise<{ success: boolean; recommendationId: string; feedbackId: string; reasonStatus: string }> {
  return apiClient.post('/api/v1/recommendations/reject', { facilityId });
}

// --- 거절 실험실 ---

export type LabReasonCode =
  | 'too_far'
  | 'too_crowded'
  | 'not_my_taste'
  | 'too_expensive'
  | 'closed'
  | 'already_visited'
  | 'bad_timing'
  | 'inaccurate'
  | 'other';

/** GET /api/v1/lab/pending 항목 — 서버가 실제로 주는 키만(lab.py _serialize_pending). */
export interface LabPendingItem {
  id: string;
  recommendationId: string;
  facilityId: string;
  facilityName: string;
  facilityType: string;
  createdAt: string;
  action?: string;
  reasonStatus?: string;
}

export async function fetchLabPending(): Promise<LabPendingItem[]> {
  return apiClient.get('/api/v1/lab/pending');
}

export async function fetchLabPendingCount(): Promise<number> {
  const data: { count: number } = await apiClient.get('/api/v1/lab/pending/count');
  return data.count;
}

export async function answerLabReason(
  feedbackId: string,
  reasonCode: string,
  reasonNote?: string,
): Promise<{ updatedVector: boolean }> {
  const data: { updatedVector?: boolean } | null = await apiClient.post(`/api/v1/lab/${feedbackId}/reason`, {
    reasonCode,
    reasonNote,
  });
  return { updatedVector: data?.updatedVector === true };
}

export async function classifyLabReason(
  feedbackId: string,
  text: string,
): Promise<{ resolved: boolean; updatedVector: boolean }> {
  const data: {
    resolved?: boolean;
    updatedVector?: boolean;
    llmStatus?: 'llm' | 'llm_failed' | 'disabled';
  } = await apiClient.post(`/api/v1/lab/${feedbackId}/reason/classify`, { text });
  if (data.llmStatus) emitLlmDebug({ feature: 'lab', status: data.llmStatus });
  return { resolved: data.resolved === true, updatedVector: data.updatedVector === true };
}

export async function skipLabItem(feedbackId: string): Promise<void> {
  await apiClient.post(`/api/v1/lab/${feedbackId}/skip`);
}

export async function hideLabItem(feedbackId: string): Promise<void> {
  await apiClient.post(`/api/v1/lab/${feedbackId}/hide`);
}

/**
 * 종류별 추천 랭킹(지도 브라우즈 · 대기 보드). 시그니처는 웹과 같다 — assumedAt(가정 시각)은 앱 v1 에서 쓰지 않지만
 * 호출부를 그대로 옮길 수 있게 자리를 남겼다(null 이면 서버 현재 시각).
 */
export async function recommendByType(
  facilityType: string,
  userLocation: { lat: number; lng: number },
  excludeIds: string[] = [],
  limit = 5,
  context?: TravelContext,
  preferenceIntent?: string | null,
  signal?: AbortSignal,
  timeoutMs?: number,
  assumedAt?: string | null,
  fillWeakerTiers: boolean = fillsWeakerTiersFor([facilityType]),
): Promise<RecommendationResponse[]> {
  const session = await ensureAnonymousSession();
  const userId = session?.user?.id;
  if (!userId) throw new AuthError();
  const { data, strollerDropped } = await postWithTravelContext<RecommendationResponse[]>('/api/v1/recommendations/by-type', {
    userId,
    facilityType,
    userLat: userLocation.lat,
    userLng: userLocation.lng,
    excludeIds,
    limit,
    context,
    preferenceIntent,
    assumedAt: assumedAt ?? null,
    fillWeakerTiers,
  }, { signal, timeoutMs });
  const res = strollerDropped ? keepStrollerFriendly(data) : data;
  emitReasonSourceDebug(res);
  return uniqueSyntheticRecommendationIds(res);
}

// --- 자연어 선호·조건 ---

export interface ParsePreferenceResult {
  preferredCategories: string[];
  attributes: string[];
  summary: string;
  isFallback: boolean;
  vectorUpdated: boolean;
  categoriesSaved: boolean;
  llmStatus?: 'keyword' | 'llm' | 'llm_failed' | 'disabled';
  /** 서버가 실제로 반영했는가. undefined(구 서버)는 '모른다' — 종전대로 성공 처리. */
  applied?: boolean;
  reason?: 'no_preference_detected' | 'storage_unavailable';
}

export async function parsePreference(text: string): Promise<ParsePreferenceResult> {
  return apiClient.post('/api/v1/preferences/parse', { text });
}

export interface ParseTravelContextResult {
  context: Partial<TravelContext>;
  llmStatus: 'keyword' | 'llm' | 'llm_failed' | 'disabled';
  requiresConfirmation: true;
}

export async function parseTravelContext(text: string): Promise<ParseTravelContextResult> {
  return apiClient.post('/api/v1/travel-context/parse', { text });
}

// --- 음성 비서 1턴(v1.1 — 시그니처만 맞춰 둔다) ---

export interface VoiceTurnCandidate {
  id: string;
  name: string;
  cuisine?: string[] | string | null;
  menu?: string | null;
  category?: string | null;
  congestion?: number | null;
  distanceM?: number;
}

export interface VoiceTurnResult {
  action: string;
  targetFacilityId: string | null;
  matchIds: string[];
  spoken: string | null;
  suggestionId?: string | null;
  llmStatus?: 'keyword' | 'llm' | 'llm_failed' | 'gated' | 'disabled';
  command?: VoiceAppCommand | null;
}

export interface VoiceAppContext {
  route: 'main';
  facilityType: PlaceCategory;
  indoorRequired: boolean;
  maxWalkMinutes?: 5 | 10 | 20 | null;
}

export async function voiceTurn(
  utterance: string,
  facilityType: string,
  currentName: string | null,
  candidates: VoiceTurnCandidate[],
  appContext?: VoiceAppContext,
): Promise<VoiceTurnResult> {
  const res: VoiceTurnResult = await apiClient.post('/api/v1/voice/turn', {
    utterance,
    facilityType,
    currentName,
    candidates,
    appContext,
  });
  if (res.llmStatus) emitLlmDebug({ feature: 'voice', status: res.llmStatus });
  return res;
}
