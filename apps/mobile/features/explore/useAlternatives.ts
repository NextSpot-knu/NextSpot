// 대안 화면의 데이터·행동 — 웹 page.tsx 의 RecommendContent(음성 비서·온보딩 모달·자연어 선호 입력 제외, 기준 커밋 0d145a1).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useBusyThreshold } from '~/lib/core/publicSettings';
import {
  getRecommendations,
  httpStatus,
  isRequestTimeout,
  loadSharedCongestionEstimates,
  recommendByType,
  reportFacilityAvailability,
  submitFeedback,
  type AvailabilityReportResult,
  type RecommendationResponse,
} from '~/lib/core/apiClient';
import { queueRecommendationOutcome } from '~/lib/core/recommendationOutcomes';
import { createPublicClient } from '~/lib/core/supabase';
import type { TFunc } from '~/lib/i18n/I18nProvider';
import { toast } from '~/components/ui';
import type { ReportLevel } from '~/features/recommendation-card/reportCore';
import { haptic } from '~/lib/platform/haptics';
import { openDrivingDirections, openExternalUrl, openWalkingDirections } from '~/lib/platform/links';
import { shareLink, type ShareOutcome } from '~/lib/platform/share';
import { recommendShareUrl } from '~/lib/platform/shareUrls';
import { track } from '~/lib/platform/analytics';
import { congestionKey } from '@/lib/congestionScale';

import {
  BY_TYPE_FALLBACK_TIMEOUT_MS,
  fetchAlternatives,
  isSyntheticRecommendationId,
  kakaoDetailsUrl,
  loadAlternativesFlow,
  needsHoursCheck,
  type OriginGrade,
} from './logic';
import { candidateTypesFor, currentOriginLevel, handoffOrigin, isNamedOrigin, type RecommendParams } from './origin';
import { parseCongestionEstimate } from './port/congestionEstimate';
import { loadTravelContext, markTasteFeedback, recordActiveTrip } from './tripAdapter';

export interface OriginFacility {
  id: string;
  name: string;
  type: string;
  /** null = 혼잡 로그 0건(합성 금지). */
  congestionLevel: number | null;
}

export interface HoursPrompt {
  recommendationId: string;
  navigationMode: 'walk' | 'car';
}

interface Args {
  params: RecommendParams;
  coords: { lat: number; lng: number };
  locationReady: boolean;
  /** coords 가 실제 내 위치인가(주소 좌표·지역 중심이 아니라). 아니면 길찾기에 출발지를 싣지 않는다(웹과 같다). */
  isUserLocation?: boolean;
  t: TFunc;
}

export function useAlternatives({ params, coords, locationReady, isUserLocation = false, t }: Args) {
  const busyAt = useBusyThreshold();
  const { facilityId, name: originNameParam, type: originTypeParam } = params;
  const named = isNamedOrigin(params);
  const tRef = useRef(t);
  tRef.current = t;

  // 다시 시도 — 원래 장소·목록 조회가 모두 이 값에 묶인다(웹 ErrorState 의 reload 와 같은 범위, G4a-28). 아래 effect 들보다 먼저 선언한다(TDZ).
  const [reloadKey, setReloadKey] = useState(0);

  // ── 원래 장소 ──
  const [loaded, setLoaded] = useState<OriginFacility | null>(null);
  const [loadingOriginalState, setLoadingOriginal] = useState(true);
  const originalTypeRef = useRef<string | null>(originTypeParam);
  const origin: OriginFacility | null =
    named && originTypeParam
      ? { id: '', name: originNameParam, type: originTypeParam, congestionLevel: null }
      : loaded;
  const loadingOriginal = named ? false : loadingOriginalState;

  useEffect(() => {
    originalTypeRef.current = originTypeParam;
    if (!facilityId) return;
    let alive = true;
    void (async () => {
      setLoadingOriginal(true);
      try {
        const { data, error } = await createPublicClient()
          .from('facilities')
          .select('id, name, type, features, congestion_logs ( congestion_level, timestamp, source, evidence_tier )')
          .eq('id', facilityId)
          .order('timestamp', { foreignTable: 'congestion_logs', ascending: false })
          .limit(10, { foreignTable: 'congestion_logs' })
          .single();
        if (!alive) return;
        if (error || !data) return; // 실데이터 전용 — 원래 장소 카드는 빈 채로 둔다.
        // '지금' 자격이 있는 관측만 — 로그 0건이면 null(0.0 으로 합성하지 않는다).
        const level = currentOriginLevel(data.congestion_logs);
        originalTypeRef.current = data.type;
        setLoaded({ id: data.id, name: data.name, type: data.type, congestionLevel: level });
      } catch (err) {
        console.warn('Failed to fetch original facility:', err);
      } finally {
        if (alive) setLoadingOriginal(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [facilityId, originTypeParam, reloadKey]);

  // 실측이 없으면 대기 보드와 같은 추정 피드에서 지금 등급을 읽는다.
  const needsOriginEstimate = !loadingOriginal && origin !== null && origin.congestionLevel === null && !!facilityId;
  const [originEstimate, setOriginEstimate] = useState<{ id: string; level: number } | null>(null);
  useEffect(() => {
    if (!needsOriginEstimate) return;
    let alive = true;
    void (async () => {
      try {
        const feed = await loadSharedCongestionEstimates();
        if (!alive || !feed?.available) return;
        const parsed = parseCongestionEstimate(feed.estimates?.[facilityId]);
        if (parsed) setOriginEstimate({ id: facilityId, level: parsed.level });
      } catch {
        /* 추정 피드 없음 — 알약 없이 제목만 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [facilityId, needsOriginEstimate]);
  const originEstimateLevel = needsOriginEstimate && originEstimate?.id === facilityId ? originEstimate.level : null;
  const originGrade: OriginGrade =
    origin?.congestionLevel != null
      ? { key: congestionKey(origin.congestionLevel, busyAt), estimated: false }
      : originEstimateLevel !== null
        ? { key: congestionKey(originEstimateLevel, busyAt), estimated: true }
        : null;

  // ── 대안 ──
  const [recommendations, setRecommendations] = useState<RecommendationResponse[]>([]);
  // '새 추천 세트' 번호 — 조회·다른 대안 보기가 세트를 바꿀 때만 올린다. 혼잡 제보 같은 카드 하나의 갱신은 배열이 새로 만들어져도 올리지 않는다.
  const [setVersion, setSetVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const coordsRef = useRef(coords);
  coordsRef.current = coords;
  const isUserLocationRef = useRef(isUserLocation);
  isUserLocationRef.current = isUserLocation;
  // 요청 세대 — 새 조회(주소·좌표 변경, 다시 시도)나 '다른 대안 보기'가 시작되면 늘린다. 늦게 온 이전 응답은 버린다.
  const genRef = useRef(0);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const deps = useCallback(
    (cancelled: () => boolean) => ({
      getRecommendations: (candidateTypes: readonly string[]) =>
        getRecommendations(
          facilityId,
          coordsRef.current,
          loadTravelContext(),
          candidateTypes.length > 0 ? { candidateTypes: [...candidateTypes] as ('restaurant' | 'cafe' | 'attraction' | 'culture')[] } : undefined,
        ),
      // 유형은 호출하는 순간 ref 에서 읽는다(원래 장소가 조회 시작 뒤에 도착한다).
      byType: () =>
        recommendByType(
          originalTypeRef.current ?? 'restaurant',
          coordsRef.current,
          facilityId ? [facilityId] : [],
          5,
          loadTravelContext(),
          undefined,
          undefined,
          BY_TYPE_FALLBACK_TIMEOUT_MS,
        ),
      isTimeout: isRequestTimeout,
      sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      cancelled,
      warn: (message: string, err?: unknown) => console.warn(message, err),
    }),
    [facilityId],
  );

  const hasOriginNow = !!facilityId || named;
  useEffect(() => {
    if (!locationReady || !hasOriginNow) return;
    let cancelled = false;
    const gen = ++genRef.current;
    const stale = () => cancelled || gen !== genRef.current;
    setLoading(true);
    void (async () => {
      try {
        const list = await loadAlternativesFlow(deps(stale), params);
        if (stale() || list === null) return;
        setRecommendations(list);
        setSetVersion((v) => v + 1);
        setLoadFailed(false);
      } catch (err) {
        if (stale()) return;
        console.warn('Error calling FastAPI, showing empty recommendations:', err);
        setRecommendations([]);
        setSetVersion((v) => v + 1);
        setLoadFailed(true);
      } finally {
        if (!stale()) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // params 는 문자열 필드만 읽는다 — 객체 정체성이 아니라 값이 deps 다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationReady, hasOriginNow, facilityId, originNameParam, originTypeParam, coords.lat, coords.lng, reloadKey, deps]);

  // 새 추천 세트엔 이전 세트의 만족도 상태가 무의미하다.
  const votedRef = useRef<Set<string>>(new Set());
  const [feedbackVotes, setFeedbackVotes] = useState<Record<string, 'up' | 'down'>>({});
  useEffect(() => {
    votedRef.current = new Set();
    setFeedbackVotes({});
  }, [setVersion]);

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  // ── 길안내 수락 ──
  const handleAccept = useCallback(
    async (rec: RecommendationResponse, navigationMode: 'walk' | 'car' = 'walk') => {
      const tt = tRef.current;
      haptic('confirm');
      toast.success(tt('recommend.acceptStart'));
      recordActiveTrip(
        {
          id: rec.facility.id,
          name: rec.facility.name,
          type: rec.facility.type,
          latitude: rec.facility.latitude,
          longitude: rec.facility.longitude,
        },
        {
          recommendationId: rec.recommendationId,
          walkMinutes: rec.breakdown.travelTime,
          context: loadTravelContext() as unknown as Record<string, unknown> | undefined,
          navigationMode,
        },
      );
      track('navigation_started', {
        facility_type: rec.facility.type,
        navigation_mode: navigationMode,
        walk_minutes: Math.round(rec.breakdown.travelTime),
      });
      // 방문 결과의 첫 단계 — 없으면 '도착 확인' 이 서버에서 409 로 거절돼 집계에서 빠진다.
      queueRecommendationOutcome(rec.recommendationId, 'navigation_started');
      const dest = { name: rec.facility.name, latitude: rec.facility.latitude, longitude: rec.facility.longitude };
      // 출발지는 실제 내 위치일 때만 — 주소 좌표·지역 중심을 출발지로 넘기면 카카오맵이 엉뚱한 곳에서 길을 그린다.
      // 없으면 카카오맵이 기기 현재 위치에서 시작한다(웹 openWalkingDirections(rec.facility) 와 같다).
      const here = coordsRef.current;
      const from = handoffOrigin(here, isUserLocationRef.current);
      if (navigationMode === 'walk') {
        toast.info(tt('trip.selectWalking'));
        void openWalkingDirections(dest, from);
      } else {
        toast.info(tt('trip.driveBasisHint'));
        void openDrivingDirections(dest, from);
      }
      try {
        markTasteFeedback();
        await submitFeedback(rec.recommendationId, 'accepted_visit_intent');
      } catch (err) {
        console.warn('Error submitting accepted feedback:', err);
      }
    },
    [],
  );

  // ── 영업시간 확인 ──
  const [hoursPrompt, setHoursPrompt] = useState<HoursPrompt | null>(null);
  const [hoursSubmitting, setHoursSubmitting] = useState(false);
  const [hoursSubmitError, setHoursSubmitError] = useState(false);

  const requestAccept = useCallback(
    (rec: RecommendationResponse, navigationMode: 'walk' | 'car' = 'walk') => {
      if (!needsHoursCheck(rec)) {
        void handleAccept(rec, navigationMode);
        return;
      }
      setHoursPrompt({ recommendationId: rec.recommendationId, navigationMode });
      setHoursSubmitError(false);
      void openExternalUrl(kakaoDetailsUrl(rec));
    },
    [handleAccept],
  );

  const dismissHoursPrompt = useCallback(() => {
    setHoursPrompt(null);
    setHoursSubmitError(false);
  }, []);

  const submitHoursStatus = useCallback(
    async (rec: RecommendationResponse, status: 'open' | 'closed') => {
      if (hoursSubmitting) return;
      const tt = tRef.current;
      setHoursSubmitting(true);
      setHoursSubmitError(false);
      try {
        let result: AvailabilityReportResult | null;
        try {
          result = await reportFacilityAvailability(rec.facility.id, status);
        } catch (err) {
          // 게스트(403)·같은 네트워크의 다른 계정이 이미 알린 장소(429)는 기록되지 않은 답으로 잇는다.
          const notRecorded = httpStatus(err);
          if (notRecorded !== 403 && notRecorded !== 429) throw err;
          result = null;
        }
        setHoursPrompt(null);
        if (status === 'closed') {
          setRecommendations((current) => current.filter((item) => item.recommendationId !== rec.recommendationId));
          toast.info(tt('card.hoursClosedRemoved'));
          return;
        }
        const confirmed: RecommendationResponse = {
          ...rec,
          openStatusAtArrival: 'open_expected',
          facility: result ? { ...rec.facility, availabilityEvidence: result } : rec.facility,
        };
        setRecommendations((current) =>
          current.map((item) => (item.recommendationId === rec.recommendationId ? confirmed : item)),
        );
        await handleAccept(confirmed, hoursPrompt?.navigationMode ?? 'walk');
      } catch {
        setHoursSubmitError(true);
      } finally {
        setHoursSubmitting(false);
      }
    },
    [handleAccept, hoursPrompt, hoursSubmitting],
  );

  // ── 만족도 피드백 ── (추천 품질 신호일 뿐 — 선호 벡터를 건드리지 않는다)
  const handleSatisfactionFeedback = useCallback(
    async (rec: RecommendationResponse, vote: 'up' | 'down') => {
      if (votedRef.current.has(rec.recommendationId)) return;
      votedRef.current.add(rec.recommendationId);
      haptic('selection');
      setFeedbackVotes((prev) => ({ ...prev, [rec.recommendationId]: vote }));
      toast.success(tRef.current(vote === 'up' ? 'recommend.feedbackUp' : 'recommend.feedbackDown'));
      if (isSyntheticRecommendationId(rec.recommendationId)) return;
      try {
        markTasteFeedback();
        await submitFeedback(rec.recommendationId, vote === 'up' ? 'helpful' : 'not_helpful');
      } catch (err) {
        console.warn('만족도 피드백 전송 실패:', err);
      }
    },
    [],
  );

  // ── 다른 대안 보기 ── (보이던 묶음 전체를 dismissed_batch 로 — 개별 장소에 대한 명시 거절이 아니다)
  const refreshingRef = useRef(false);
  const handleRefresh = useCallback(async () => {
    if (recommendations.length === 0 || refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    const tt = tRef.current;
    // 이 새로고침도 한 세대다 — 도중에 주소가 바뀌어 새 조회가 시작되거나 화면이 닫히면 결과를 버린다.
    const gen = ++genRef.current;
    const stale = () => !aliveRef.current || gen !== genRef.current;
    try {
      await Promise.allSettled(
        recommendations
          .filter((rec) => !isSyntheticRecommendationId(rec.recommendationId))
          .map((rec) => submitFeedback(rec.recommendationId, 'dismissed_batch')),
      );
      try {
        const d = deps(stale);
        const fresh = await fetchAlternatives({ getRecommendations: d.getRecommendations, byType: d.byType }, params);
        if (stale()) return;
        setRecommendations(fresh);
        setSetVersion((v) => v + 1);
        setLoadFailed(false);
      } catch (e) {
        if (stale()) return;
        console.warn('refresh fetch failed, showing empty recommendations:', e);
        setRecommendations([]);
        setSetVersion((v) => v + 1);
        setLoadFailed(true);
      }
      toast.success(tt('recommend.refreshed'));
    } catch (err) {
      if (stale()) return;
      console.warn('Error during rejecting and refreshing:', err);
      toast.error(tt('recommend.refreshError'));
    } finally {
      refreshingRef.current = false;
      if (aliveRef.current) setRefreshing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recommendations, deps, facilityId, originNameParam, originTypeParam]);

  // ── 혼잡 제보 ── 제보 직후에는 서버 재조회 없이 이 카드만 실측 상태로 갱신한다(웹 onReported, G4a-22).
  // congestionIsCurrent 를 함께 덮어써야 한다 — 남기면 방금 본 제보가 '마지막 관측' 으로 밀리고 추정이 '지금' 을 차지한다.
  const markReported = useCallback((rec: RecommendationResponse, level: ReportLevel) => {
    const congestionLevel = level === '한산' ? 0.2 : level === '보통' ? 0.5 : 0.8;
    const congestionTimestamp = new Date().toISOString();
    setRecommendations((current) =>
      current.map((item) =>
        item.recommendationId === rec.recommendationId
          ? {
              ...item,
              congestionLevel,
              congestionSource: 'measured',
              congestionTimestamp,
              congestionLogSource: 'user_report',
              congestionIsStale: false,
              congestionIsCurrent: true,
            }
          : item,
      ),
    );
  }, []);

  // ── 공유 ── (링크는 같은 화면으로 돌아오되 ref=share 가 붙는다)
  // 결과(복사·실패)별 토스트와 ✓ 는 ShareButton 이 띄운다 — 여기서는 결과만 돌려준다(이중 알림 방지, G4a-23).
  const handleShare = useCallback(
    async (rec: RecommendationResponse): Promise<ShareOutcome> => {
      const tt = tRef.current;
      const here = coordsRef.current;
      const url = recommendShareUrl({
        facilityId: facilityId || null,
        name: originNameParam,
        type: originTypeParam,
        lat: here.lat,
        lng: here.lng,
      });
      return shareLink({
        title: tt('common.appName'),
        message: tt('recommend.shareText', { name: rec.facility.name }),
        url,
      });
    },
    [facilityId, originNameParam, originTypeParam],
  );
  // 공유 실패 토스트 아래에 보일 주소(웹 ShareButton url).
  const shareUrl = useMemo(
    () =>
      recommendShareUrl({
        facilityId: facilityId || null,
        name: originNameParam,
        type: originTypeParam,
        lat: coords.lat,
        lng: coords.lng,
      }),
    [facilityId, originNameParam, originTypeParam, coords.lat, coords.lng],
  );

  const noAlternatives = !loading && !loadFailed && recommendations.length === 0;
  const candidateTypes = useMemo(() => candidateTypesFor(originTypeParam), [originTypeParam]);

  return {
    busyAt,
    origin,
    loadingOriginal,
    originGrade,
    recommendations,
    loading,
    loadFailed,
    noAlternatives,
    refreshing,
    candidateTypes,
    feedbackVotes,
    hoursPrompt,
    hoursSubmitting,
    hoursSubmitError,
    retry,
    requestAccept,
    dismissHoursPrompt,
    submitHoursStatus,
    handleSatisfactionFeedback,
    handleRefresh,
    handleShare,
    markReported,
    shareUrl,
  };
}
