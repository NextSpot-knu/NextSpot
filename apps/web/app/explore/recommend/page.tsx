"use client";

import React, { useState, useEffect, useRef, useMemo, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { ErrorState } from "@/components/ErrorState";
import { createPublicClient } from "@/lib/supabase";
const supabase = createPublicClient();
import { apiClient, getRecommendations, reportFacilityAvailability, submitFeedback, parsePreference, RecommendationResponse } from "@/lib/api-client";
import { displayWalkingMinutes, MAX_RECO_DISTANCE_M } from "@/lib/recommender"; // 빈 상태 문구의 반경(1.5km) — 하드코딩 대신 실제 컷오프 상수 사용
import { classifyIntent, buildCardSpeech } from "@/lib/voice/voiceIntent";
import { getArrivalOpenDisplayStatus, isClosedToday } from "@/lib/restDate";
import { REGION, isWithinRegion } from "@/lib/region";
import { toast } from "sonner";
import { useI18n, useT } from "@/lib/i18n/I18nProvider";
import { ShareButton } from "@/components/ShareButton";
import { CongestionReportButton } from "@/components/CongestionReportButton";
import RecommendationComparison from "@/components/RecommendationComparison";
import { recordActiveTrip } from "@/lib/visits";
import { openDrivingDirections, openWalkingDirections } from "@/lib/navigation";
import { track } from "@/lib/analytics";
import { loadTravelContext } from "@/lib/travelContext";
import { relativeParts } from "@/lib/freshness";
import { congestionDisplay, estimateRadiusKm, formatEstimateTime, formatLastObserved } from "@/lib/congestionEstimate";
import { congestionKey } from "@/lib/congestionScale";
import { useBusyThreshold } from "@/components/shell/PublicSettingsProvider";
import { buildSpotComparisons, formatSpotComparison } from "@/lib/spotComparison";

// (window.kakao 타입은 types/kakao-maps.d.ts 가 전역으로 선언한다 — 파일마다 declare global 로
//  중복 선언하던 `kakao: any` 를 걷어냈다.)

// 데모 회복탄력성: 백엔드 사유(reason)가 없을 때도 추천 사유가 비지 않도록
// 보여줄 결정적 한국어 사유를 생성한다. 백엔드 reason_service._build_template 와 어투를 맞춰 일관성 유지.
function buildFallbackReason(
  t: (key: string, vars?: Record<string, string | number>) => string,
  name: string,
  waitMin: number | null,
  distanceM: number,
  congestionLevel: number | null = null,
): string {
  const walk = displayWalkingMinutes(undefined, distanceM);
  // 혼잡(>=0.75)이면 추천하지 않고 혼잡·대기를 솔직히 알린다.
  if (congestionLevel !== null && congestionLevel >= 0.75) {
    return t('recommend.fallbackBusy', { name, walk, pct: Math.round(congestionLevel * 100) });
  }
  // 혼잡 근거가 없으면 '여유'라는 혼잡 주장을 지어내지 않는다(CONGESTION_TRUST_SPEC).
  if (congestionLevel === null) {
    return waitMin === null
      ? t('recommend.fallbackTravelOnly', { name, walk })
      : t('recommend.fallbackWithWait', { name, walk, wait: Math.round(waitMin) });
  }
  return waitMin === null
    ? t('recommend.fallbackMeasured', { name, walk })
    : t('recommend.fallbackWithWait', { name, walk, wait: Math.round(waitMin) });
}

/**
 * 문장(사유·음성)이 '지금 이만큼 붐빈다' 고 **주장해도 되는** 값. 아니면 null.
 *
 * 백엔드 _reason_congestion_ctx(app/routers/recommendations.py)와 같은 판단이다. 서버가 한국어
 * 사유에서 그 주장을 이미 걷어내지만, 이 화면은 ko 가 아니면 **언제나** 위 클라이언트 폴백 문장을
 * 쓰고(`locale === 'ko' && rec.reason` 조건), 그 문장이 다시 원시 congestionLevel 을 읽었다.
 * 그래서 en/ja/zh 에서는 배지가 '추정 · 여유' 인데 문장은 "혼잡도 92%" 가 됐고, 같은 문자열이
 * 음성으로도 읽혔다(2026-09-20 적대적 검토). 판정은 congestionDisplay 한 곳에서만 한다.
 */
function assertableCongestionLevel(rec: RecommendationResponse): number | null {
  const display = congestionDisplay(rec);
  return display.mode === 'measured' || display.mode === 'predicted' ? display.level : null;
}

// 합성 추천 id 판별 — mock-(데모 폴백, by-type 저장 실패분 포함)은 recommendations 테이블에
// 행이 없어 /feedback 이 404 다. 서버 전송 전 걸러 404 소음을 만들지 않는다.
// ('bytype-' 가드는 지웠다. 그 접두사를 **만드는 코드가 저장소에 없다** — by-type 은 이제
//  노출을 전부 저장하고 실제 UUID 를 돌려준다. 아무것도 걸러내지 않는 죽은 조건이었다.)
function isSyntheticRecommendationId(id: string): boolean {
  return id.startsWith("mock-");
}

// 선호 파싱 llm_status → LLM 동작 디버그 배지(개발 전용). api-client 가 voice/lab 응답에서
// 발행하는 것과 동일한 'nextspot:llm-debug' CustomEvent 를 그대로 사용한다(LlmDebugToast 구독).
function dispatchPrefLlmDebug(status: string | undefined): void {
  if (!status || typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent("nextspot:llm-debug", { detail: { feature: "pref", status } }));
  } catch {
    // 디버그 배지는 주 기능(선호 반영)을 절대 방해하지 않는다 — 어떤 예외도 조용히 무시.
  }
}

// 백엔드 /preferences/parse 의 구조화 코드 → 현재 로케일 요약문 조립.
// 백엔드 summary 는 한국어 단일 폴백이라 표시는 프런트 t() 키로 만든다(4로케일 — 기획 P0-1 ②).
const NL_CATEGORY_CODES = ["restaurant", "cafe", "attraction", "culture"];
const NL_ATTR_KEYS: Record<string, string> = {
  tasty: "recommend.nlAttrTasty",
  instagrammable: "recommend.nlAttrInstagrammable",
  barrier_free: "recommend.nlAttrBarrierFree",
  quiet: "recommend.nlAttrQuiet",
  near: "recommend.nlAttrNear",
  indoor: "recommend.nlAttrIndoor",
};

function buildNlSummary(
  t: (key: string, vars?: Record<string, string | number>) => string,
  cats: string[],
  attrs: string[]
): string {
  // 서버가 화이트리스트를 보장하지만, 알 수 없는 코드가 와도 원시 키가 노출되지 않게 재필터.
  const catLabels = cats.filter((c) => NL_CATEGORY_CODES.includes(c)).map((c) => t(`category.${c}`));
  const attrLabels = attrs.filter((a) => a in NL_ATTR_KEYS).map((a) => t(NL_ATTR_KEYS[a]));
  if (!catLabels.length && !attrLabels.length) return t("recommend.nlSummaryEmpty");
  const catStr = catLabels.length ? catLabels.join(" · ") : t("recommend.nlSummaryAnyPlace");
  return attrLabels.length
    ? t("recommend.nlSummaryUnderstood", { cats: catStr, attrs: attrLabels.join(", ") })
    : t("recommend.nlSummaryCatsOnly", { cats: catStr });
}

// MiniMap Component for Kakao Maps inside alternative cards
interface MiniMapProps {
  latitude: number;
  longitude: number;
  mapLoaded: boolean;
}

const MiniMap = React.memo(({ latitude, longitude, mapLoaded }: MiniMapProps) => {
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<kakao.maps.Map | null>(null);
  const [isSimulation, setIsSimulation] = useState(false);

  useEffect(() => {
    const appKey = process.env.NEXT_PUBLIC_KAKAO_MAPS_APP_KEY || process.env.NEXT_PUBLIC_KAKAO_API_KEY || process.env.NEXT_PUBLIC_KAKAO_MAP_KEY || "";
    const isMock = !appKey || appKey.includes("mock") || appKey.includes("your-");

    if (isMock) {
      setIsSimulation(true);
      return;
    }

    if (!mapLoaded || !containerRef.current || !window.kakao) return;

    const kakao = window.kakao;
    const center = new kakao.maps.LatLng(latitude, longitude);

    const mapOptions = {
      center,
      level: 3,
      draggable: false,
      zoomable: false,
    };

    const map = new kakao.maps.Map(containerRef.current, mapOptions);
    mapRef.current = map;

    new kakao.maps.Marker({
      position: center,
      map: map,
    });
  }, [mapLoaded, latitude, longitude]);

  if (isSimulation) {
    // 지도 키 미설정(목업) 시: 관제 디지털트윈(격자 배경·레이더 동심원·회전 스캔라인·좌표 HUD·
    // "Twin Node Active" 영문 라벨)을 걷어내고, 한지 톤의 차분한 위치 미리보기로 대체한다.
    // 위치 핀 + 간단한 지역 표기만 담백하게 — 사이버/회로 모티프 제거.
    return (
      <div className="w-full h-24 md:h-28 rounded-xl overflow-hidden border border-line bg-hanji-deep flex flex-col items-center justify-center gap-1.5 p-3 relative select-none">
        {/* 은은한 노을빛 광원(콜드 blue 글로우 대체) */}
        <div className="absolute -top-6 -right-6 w-20 h-20 rounded-full bg-sunset-1/15 blur-2xl pointer-events-none" />
        {/* 위치 핀 */}
        <span className="relative z-10 text-lg" aria-hidden="true">📍</span>
        <div className="relative z-10 text-center leading-tight">
          <div className="text-[11px] font-semibold text-muk">{t("recommend.mapPreviewRegion")}</div>
          <div className="text-[10px] text-muk-soft mt-0.5">{t("recommend.mapPreviewLabel")}</div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="nextspot-map w-full h-24 md:h-28 rounded-xl overflow-hidden border border-line"
    />
  );
});
MiniMap.displayName = "MiniMap";

// Original Facility Interface
// congestionLevel=null → 혼잡 로그 0건(합성 금지 — 중립 헤드라인, CONGESTION_TRUST_SPEC)
interface OriginalFacility {
  id: string;
  name: string;
  type: string;
  congestionLevel: number | null;
  features: Record<string, unknown>;
}



// The core content wrapper component that handles Search Params
function RecommendContent() {
  const { t, locale } = useI18n();
  // 운영자 '혼잡' 경계 — 추정 배지 등급 전용(지도·코스와 같은 선). 기존 실측 배지는 0.75 고정 그대로다.
  const busyAt = useBusyThreshold();
  const searchParams = useSearchParams();
  const router = useRouter();

  // Query Params
  const facilityId = searchParams.get("facilityId") || "";
  const paramLat = searchParams.get("lat");
  const paramLng = searchParams.get("lng");

  // State
  const [userId, setUserId] = useState<string | null>(null);
  const [originalFacility, setOriginalFacility] = useState<OriginalFacility | null>(null);
  const [recommendations, setRecommendations] = useState<RecommendationResponse[]>([]);
  const spotComparisonById = useMemo(() => {
    const comparisons = buildSpotComparisons(recommendations.slice(0, 3).map((item, index) => ({
      id: item.recommendationId,
      rank: item.rank ?? index + 1,
      spotScore: item.spotScore <= 1 ? item.spotScore * 100 : item.spotScore,
      preference: item.breakdown.preference ?? 0,
      travelMinutes: typeof item.breakdown.travelTime === 'number'
        ? item.breakdown.travelTime : displayWalkingMinutes(undefined, item.distanceM),
      rankingWaitMinutes: item.breakdown.rankingWaitTime ?? item.breakdown.waitTime,
      areaDemandPenaltyMinutes: item.breakdown.areaDemandPenaltyMinutes,
      incentive: item.breakdown.incentive,
    })));
    return new Map(comparisons.map((comparison) => [
      comparison.id,
      formatSpotComparison(t, comparison),
    ]));
  }, [recommendations, t]);
  
  const [loadingOriginal, setLoadingOriginal] = useState(true);
  const [loadingRecommendations, setLoadingRecommendations] = useState(true);
  // 조회 실패를 빈 결과와 **구분**한다. 예전에는 네 경로가 전부 setRecommendations([])
  // 로 수렴해서, 백엔드가 죽어도 화면에는 "1.5km 내에 갈 곳이 없어요" 가 떴다 —
  // 사실이 아닌 문장이고, 사용자는 앱이 아니라 자기 위치를 의심하게 된다.
  const [loadFailed, setLoadFailed] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [mapLoaded, setMapLoaded] = useState(false);

  // facilityId 없이 진입(깨진 공유 링크·URL 직접 입력) 가드 — 정적 export(SSR)에서는 서버 렌더 시점에
  // searchParams 가 비어 보일 수 있으므로, 마운트 확정 전에는 항상 스켈레톤을 유지하고 마운트 후에만
  // facilityId 부재를 판정한다(I18nProvider 마운트-후-스왑 패턴과 동일 — CongestionAlertToggle 참고).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Onboarding Modal State (Cold Start)
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [selectedOnboardingCats, setSelectedOnboardingCats] = useState<string[]>([]);
  const [isOnboardingSubmitting, setIsOnboardingSubmitting] = useState(false);

  // 자연어 선호 입력(텍스트 + 음성) 상태
  const [nlText, setNlText] = useState("");
  const [isParsingNl, setIsParsingNl] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [nlSummary, setNlSummary] = useState<string | null>(null);
  const [nlApplied, setNlApplied] = useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  // 빠른 더블클릭으로 인한 중복 피드백 전송 방지 — 리렌더 전에도 동기적으로 차단되는 가드
  const votedRef = useRef<Set<string>>(new Set());
  // 음성 '다음'(skipped) 중복 전송 방지 — 만족도(votedRef)와 별개 어휘라 집합을 분리한다.
  const skippedRef = useRef<Set<string>>(new Set());


  // 추천별 만족도 피드백(👍/👎) 기록 — 중복 전송 방지 + 버튼 선택 상태 표시
  const [feedbackVotes, setFeedbackVotes] = useState<Record<string, "up" | "down">>({});
  const [hoursPrompt, setHoursPrompt] = useState<{
    recommendationId: string;
    navigationMode: 'walk' | 'car';
  } | null>(null);
  const [hoursSubmitting, setHoursSubmitting] = useState(false);
  const [hoursSubmitError, setHoursSubmitError] = useState(false);

  // Coordinates used for recommendations
  const [lat, setLat] = useState<number>(REGION.center.lat);
  const [lng, setLng] = useState<number>(REGION.center.lng);

  // ── 음성 비서(음성 컨시어지) 상태 ──
  // 백엔드가 만든 추천 사유를 한국어 TTS로 읽어주고(speechSynthesis), 사용자의 음성 응답을
  // STT(SpeechRecognition)로 받아 기존 핸들러(handleAccept/만족도/새로고침)에 위임한다.
  // 정적 export(SSR) 안전: 모든 Web Speech 접근은 핸들러/이펙트 내부 + typeof window 가드.
  const [assistantActive, setAssistantActive] = useState(false);
  const [voiceState, setVoiceState] = useState<"idle" | "speaking" | "listening" | "thinking">("idle");
  const [activeRecIndex, setActiveRecIndex] = useState(0);
  const [liveTranscript, setLiveTranscript] = useState("");
  const [assistantMuted, setAssistantMuted] = useState(false);
  const [ttsSupported, setTtsSupported] = useState(true);
  const [sttSupported, setSttSupported] = useState(true);
  const [spokenCaption, setSpokenCaption] = useState(""); // 현재 발화 텍스트(자막=청각 정보 시각 동시 제공)

  const assistantRecRef = useRef<SpeechRecognition | null>(null);
  const voiceUnlockedRef = useRef(false);
  const listenTimeoutRef = useRef<number | null>(null);
  const speakFollowupRef = useRef<number | null>(null); // 발화 후 STT 시작 예약 타이머(정리 추적)
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  const voiceStateRef = useRef<"idle" | "speaking" | "listening" | "thinking">("idle");
  const activeRecIndexRef = useRef(0);
  const mutedRef = useRef(false);
  const recommendationsRef = useRef<RecommendationResponse[]>([]);
  const repromptCountRef = useRef(0);
  const startingRef = useRef(false);

  // 상태와 ref를 동시에 갱신(비동기 콜백에서 stale 값 방지).
  const setVoice = (s: "idle" | "speaking" | "listening" | "thinking") => {
    voiceStateRef.current = s;
    setVoiceState(s);
  };
  const setActiveRec = (i: number) => {
    activeRecIndexRef.current = i;
    setActiveRecIndex(i);
  };
  // 음성 비서 즉시 정리(수동 조작/언마운트/모달 전환/새 추천 도착 시). 후속 헬퍼에 의존하지 않게 위쪽에 정의.
  const quietAssistant = () => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
    try { assistantRecRef.current?.abort?.(); } catch { /* noop */ }
    if (listenTimeoutRef.current) { clearTimeout(listenTimeoutRef.current); listenTimeoutRef.current = null; }
    if (speakFollowupRef.current) { clearTimeout(speakFollowupRef.current); speakFollowupRef.current = null; }
    startingRef.current = false;
    repromptCountRef.current = 0;
    voiceStateRef.current = "idle";
    setVoiceState("idle");
    setAssistantActive(false);
    setLiveTranscript("");
    setSpokenCaption("");
  };

  // 음성 비서: 브라우저 지원 감지 + 한국어 보이스 캐싱(마운트 1회).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const synthOk = "speechSynthesis" in window;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    setTtsSupported(synthOk);
    setSttSupported(!!SR);
    if (!synthOk) return;
    const loadVoices = () => { voicesRef.current = window.speechSynthesis.getVoices() || []; };
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
    return () => {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.onvoiceschanged = null;
      }
    };
  }, []);

  // 최신 추천 배열을 비동기 콜백 클로저에서 참조하기 위한 미러.
  useEffect(() => { recommendationsRef.current = recommendations; }, [recommendations]);

  // 새 추천 세트가 도착하면 음성 비서를 idle로 되돌린다(자동재생 정책 회피 — 재탭 요구, 매 시연 동일).
  useEffect(() => {
    setActiveRec(0);
    quietAssistant();
    // 새 추천 세트엔 이전 세트의 만족도 상태가 무의미하다. 같은 recommendationId 가 다시 와도
    // 새 카드의 👍/👎 가 잠기지 않도록 초기화한다.
    votedRef.current = new Set();
    skippedRef.current = new Set();
    setFeedbackVotes({});
  }, [recommendations]);

  // 온보딩 모달이 열리면 음성 비서 정지, 닫히면 온보딩 음성입력(recognitionRef)도 정지(이중 인식 충돌 방지).
  useEffect(() => {
    if (showOnboarding) {
      quietAssistant();
    } else {
      try { recognitionRef.current?.stop?.(); } catch { /* noop */ }
      setIsListening(false);
    }
  }, [showOnboarding]);

  // 탭이 숨겨지면(백그라운드) 발화/인식 정지 — 일부 브라우저의 발화 큐잉/정지 이슈 회피.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => { if (document.hidden) quietAssistant(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // 언마운트 시 정리(발화/인식/타이머).
  useEffect(() => {
    return () => {
      if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
      try { assistantRecRef.current?.abort?.(); } catch { /* noop */ }
      if (listenTimeoutRef.current) clearTimeout(listenTimeoutRef.current);
      if (speakFollowupRef.current) clearTimeout(speakFollowupRef.current);
    };
  }, []);

  // Load User ID and Kakao Maps SDK
  useEffect(() => {
    // 1. Fetch User Session
    //    SessionBootstrap(익명 로그인)이 잡히면 실제 per-device id 를 쓴다. 아직 세션이 없거나
    //    프로젝트에서 익명 로그인이 비활성이면 목업 방문자로 폴백(기존 동작 유지, 무회귀).
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        setUserId(session.user.id);
      } else {
        console.warn("No active session yet, using mock visitor until anonymous session bootstraps.");
        setUserId("a2222222-2222-2222-2222-222222222222"); // Fallback mock visitor ID
      }
    });

    // 1-1. 익명 세션이 (부트스트랩 지연으로) 뒤늦게 잡히면 실제 id 로 승격 → 추천이 실제 세션으로 재조회된다.
    //      body user_id 와 첨부 토큰(api-client)이 같은 세션에서 나오므로 백엔드 IDOR 가드와 정합.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) setUserId(session.user.id);
    });

    // 2. Load Kakao Maps Script
    const appKey = process.env.NEXT_PUBLIC_KAKAO_MAPS_APP_KEY || process.env.NEXT_PUBLIC_KAKAO_API_KEY || process.env.NEXT_PUBLIC_KAKAO_MAP_KEY || "";
    if (appKey) {
      const scriptId = "kakao-maps-sdk-recommend";
      let script = document.getElementById(scriptId) as HTMLScriptElement;

      if (!script) {
        script = document.createElement("script");
        script.id = scriptId;
        script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${appKey}&autoload=false`;
        script.async = true;
        script.onload = () => {
          if (window.kakao && window.kakao.maps) {
            window.kakao.maps.load(() => setMapLoaded(true));
          }
        };
        document.head.appendChild(script);
      } else if (window.kakao && window.kakao.maps) {
        window.kakao.maps.load(() => setMapLoaded(true));
      }
    }

    return () => { subscription?.unsubscribe?.(); };
  }, []);

  // Fetch coordinates from params or fall back to browser Geolocation
  useEffect(() => {
    if (paramLat && paramLng) {
      setLat(parseFloat(paramLat));
      setLng(parseFloat(paramLng));
    } else if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          let userLat = pos.coords.latitude;
          let userLng = pos.coords.longitude;

          // 서비스 지역(지오펜스) 밖이면 지역 중심점으로 모킹 — 경계/중심은 lib/region.ts 단일 소스
          if (!isWithinRegion(userLat, userLng)) {
            userLat = REGION.center.lat;
            userLng = REGION.center.lng;
            console.log(`User is outside ${REGION.name}. Mocking location to region center:`, userLat, userLng);
          }

          setLat(userLat);
          setLng(userLng);
        },
        (err) => {
          console.warn("Geolocation fallback failed, using default Gyeongju center.", err);
          // 위치 실패 시 조용히 안내 — 거리·도보 시간이 경주 중심 기준임을 알린다(무음 폴백 방지).
          toast.info(t("map.locationFallback"));
        }
      );
    }
  }, [paramLat, paramLng]);

  // 공유 유입 계측 — 공유 링크(ref=share)로 들어온 방문을 무인증 이벤트로 1회 기록한다(계약 6).
  // fire-and-forget: 실패해도 페이지 동작에 영향 없음(사용자에게 에러 노출 안 함).
  useEffect(() => {
    if (searchParams.get("ref") === "share") {
      apiClient
        .post("/api/v1/events/track", { event: "share_visit", props: { ref: "share" } })
        .catch(() => { /* 계측 실패는 조용히 무시 */ });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load Original Facility Details
  useEffect(() => {
    if (!facilityId) return;

    async function fetchOriginalFacility() {
      setLoadingOriginal(true);
      try {
        const { data, error } = await supabase
          .from("facilities")
          .select(`
            id,
            name,
            type,
            features,
            congestion_logs (
              congestion_level,
              timestamp,
              source,
              evidence_tier
            )
          `)
          .eq("id", facilityId)
          .order("timestamp", { foreignTable: "congestion_logs", ascending: false })
          .limit(10, { foreignTable: "congestion_logs" })
          .single();

        let originalData = data;
        if (error || !data) {
          // 실데이터 전용: 목업 폴백 없음 — 조회 실패 시 원시설 카드는 빈 상태로 둔다.
          console.warn("Failed to load original facility details.");
          originalData = null;
        }

        if (originalData) {
          const latestLog = originalData.congestion_logs?.find((log: { source?: string; evidence_tier?: string }) =>
            log.source !== 'seed' && log.source !== 'simulated' && log.evidence_tier !== 'synthetic'
          );
          // 로그 0건이면 null 유지 — 0.0(실측 여유)으로 합성하지 않는다(CONGESTION_TRUST_SPEC).
          const level = latestLog ? latestLog.congestion_level : null;

          setOriginalFacility({
            id: originalData.id,
            name: originalData.name,
            type: originalData.type,
            congestionLevel: level,
            features: originalData.features || {},
          });
          // 정성 혼잡 관측만으로 대기시간을 역산하지 않는다. 검증 모델/실제 줄 데이터가 없으므로 "--" 유지.
        }
      } catch (err) {
        // 실데이터 전용: 목업 폴백 없음 — 원시설 카드는 빈 상태로 둔다.
        console.warn("Failed to fetch original facility:", err);
      } finally {
        setLoadingOriginal(false);
      }
    }

    fetchOriginalFacility();
  }, [facilityId]);

  // Check Cold Start & Fetch Recommendations
  useEffect(() => {
    if (!userId || !facilityId) return;
    let cancelled = false;  // in-flight 가드: lat/lng 늦은 갱신 등으로 인한 잔여 응답 경합 방지

    async function checkHistoryAndFetch() {
      setLoadingRecommendations(true);
      try {
        // 온보딩 완료 로컬 플래그: RLS 강화로 세션 없는(데모) 사용자는 recommendations count 가
        // 항상 0 으로 보이므로, DB count 만으로 판정하면 매 방문마다 온보딩이 뜬다(WS-A 후속).
        let onboardingDone = false;
        try {
          onboardingDone = localStorage.getItem("nextspot_onboarding_done") === "1";
        } catch { /* localStorage 차단 환경 — DB count 판정만 사용 */ }

        const { count, error } = await supabase
          .from("recommendations")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId);

        if (cancelled) return;
        if (!error && count === 0 && !onboardingDone) {
          setShowOnboarding(true);
          setLoadingRecommendations(false);
          return;
        }

        const recommendationsList = await getRecommendations(facilityId, { lat, lng }, loadTravelContext());
        if (cancelled) return;
        setRecommendations(recommendationsList);
        setLoadFailed(false);
      } catch (err) {
        if (cancelled) return;
        // 실데이터 전용: FastAPI 미가용 시 목업 폴백 없이 빈 추천(빈 상태 UI)으로 처리한다.
        console.warn("Error calling FastAPI, showing empty recommendations:", err);
        setRecommendations([]);
        setLoadFailed(true);
      } finally {
        if (!cancelled) setLoadingRecommendations(false);
      }
    }

    checkHistoryAndFetch();
    return () => { cancelled = true; };
    // originalFacility 를 deps 에 넣지 않음: 매번 새 객체로 세팅돼 추천을 이중 fetch 시키던 경합의 원인이었다.
  }, [userId, facilityId, lat, lng]);

  // 음성 입력 시작 (Web Speech API). 미지원 브라우저는 텍스트 입력으로 폴백.
  const startVoice = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      toast.error(t("recommend.voiceUnsupported"));
      return;
    }
    try {
      const rec = new SR();
      rec.lang = "ko-KR";
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      rec.onresult = (e: SpeechRecognitionEvent) => {
        const transcript = e.results?.[0]?.[0]?.transcript ?? "";
        if (transcript) setNlText((prev) => (prev ? prev + " " : "") + transcript);
      };
      rec.onend = () => setIsListening(false);
      rec.onerror = () => {
        setIsListening(false);
        toast.error(t("recommend.voiceFailed"));
      };
      recognitionRef.current = rec;
      setIsListening(true);
      rec.start();
    } catch {
      setIsListening(false);
      toast.error(t("recommend.voiceStartFailed"));
    }
  };

  const stopVoice = () => {
    try {
      recognitionRef.current?.stop();
    } catch {
      /* noop */
    }
    setIsListening(false);
  };

  // 자연어 → 백엔드 키워드 파싱 → 선호 벡터/카테고리 반영 (서버가 저장까지 수행)
  const handleNlAnalyze = async () => {
    if (!nlText.trim()) {
      toast.info(t("recommend.nlEmpty"));
      return;
    }
    setIsParsingNl(true);
    try {
      const result = await parsePreference(nlText.trim());
      // llmStatus 는 신버전 백엔드만 준다 — 없으면 배지 미발행(구버전 응답 무해).
      dispatchPrefLlmDebug(result.llmStatus);
      // 백엔드 summary(한국어 단일) 대신 구조화 코드로 로케일별 요약을 조립한다.
      setNlSummary(buildNlSummary(t, result.preferredCategories ?? [], result.attributes ?? []));
      // 서버가 **실제로 반영했는가**를 본다. 2xx 만 보고 '반영했어요' 라고 말하면,
      // 아무 선호도 못 알아들어 서버가 아무것도 쓰지 않은 경우에도 성공이라고 말하게 된다.
      // (구버전 백엔드는 applied 를 안 준다 — undefined 는 '모른다' 라 종전대로 성공 처리한다.)
      if (result.applied === false) {
        setNlApplied(false);
        toast.info(
          result.reason === "storage_unavailable"
            ? t("recommend.nlSaveFailed")
            : t("recommend.nlNotApplied"),
        );
        return;
      }
      if (result.preferredCategories?.length) {
        setSelectedOnboardingCats(result.preferredCategories);
      }
      setNlApplied(true);
      toast.success(result.isFallback ? t("recommend.nlAppliedKeyword") : t("recommend.nlAppliedAi"));
    } catch (err) {
      // 서버 연결 실패 시 클라이언트 키워드 폴백 — 데모가 끊기지 않게.
      console.warn("NL preference parse failed, client-side keyword fallback:", err);
      const low = nlText.toLowerCase();
      const kw: Record<string, string[]> = {
        restaurant: ["식당", "밥", "점심", "먹", "맛집", "한식", "국밥", "고기", "분식"],
        cafe: ["카페", "커피", "디저트", "빵", "베이커리", "감성"],
        attraction: ["관광", "명소", "구경", "유적", "첨성대", "대릉원", "야경"],
        culture: ["문화", "박물관", "전시", "한옥", "공예", "체험", "고택"],
      };
      const cats = Object.entries(kw)
        .filter(([, ws]) => ws.some((w) => low.includes(w)))
        .map(([c]) => c);
      if (cats.length) {
        setSelectedOnboardingCats(cats);
        setNlSummary(t("recommend.nlSummaryFallback"));
        setNlApplied(true);
        toast.success(t("recommend.nlAppliedKeyword2"));
      } else {
        toast.error(t("recommend.nlAnalyzeFailed"));
      }
    } finally {
      setIsParsingNl(false);
    }
  };

  // 자연어 선호 반영 후 바로 추천 받기 (parse 단계에서 서버가 이미 벡터/카테고리 저장)
  const handleApplyNlAndFetch = async () => {
    if (!userId || !facilityId) return;
    stopVoice();
    setShowOnboarding(false);
    setLoadingRecommendations(true);
    try {
      const list = await getRecommendations(facilityId, { lat, lng }, loadTravelContext());
      setRecommendations(list);
      setLoadFailed(false);
    } catch (err) {
      // 실데이터 전용: 목업 폴백 없음 — 빈 추천(빈 상태 UI)으로 처리한다.
      console.warn("Fetch after NL preference failed, showing empty recommendations:", err);
      setRecommendations([]);
      setLoadFailed(true);
    } finally {
      setLoadingRecommendations(false);
    }
  };

  // Handle Onboarding Preferences Submission
  const handleOnboardingSubmit = async () => {
    if (selectedOnboardingCats.length < 3) {
      toast.info(t("recommend.selectAtLeast3"));
      return;
    }
    if (!userId || !facilityId) return;

    setIsOnboardingSubmitting(true);
    try {
      // 1. Update preferred categories in Postgres users table
      const { error } = await supabase
        .from("users")
        .update({ preferred_categories: selectedOnboardingCats })
        .eq("id", userId);

      if (error) {
        console.warn("Supabase user update skipped/failed (common in mock session):", error);
      }

      setShowOnboarding(false);
      try {
        localStorage.setItem("nextspot_onboarding_done", "1");
      } catch { /* localStorage 차단 환경 — 무시 */ }
      toast.success(t("recommend.prefSaved"));

      // 2. Fetch recommendations — 선호 벡터가 없으면 FastAPI가 방금 갱신한 users.preferred_categories 로
      // 카테고리 평균 벡터를 생성해 Supabase에 저장한 뒤 추천을 계산한다(로컬 연산, 외부 벡터 DB 없음).
      setLoadingRecommendations(true);
      const recommendationsList = await getRecommendations(facilityId, { lat, lng }, loadTravelContext());
      setRecommendations(recommendationsList);
      setLoadFailed(false);
    } catch (err) {
      // 실데이터 전용: FastAPI 추천 실패 시 목업 폴백 없이 빈 추천(빈 상태 UI)으로 처리한다.
      console.warn("Error during onboarding recommend fetch:", err);
      setRecommendations([]);
      setLoadFailed(true);
      setShowOnboarding(false);
    } finally {
      setIsOnboardingSubmitting(false);
      setLoadingRecommendations(false);
    }
  };

  // CTA Click: Accept Alternative
  const handleAccept = async (rec: RecommendationResponse, navigationMode: 'walk' | 'car' = 'walk') => {
    quietAssistant(); // 음성 비서 진행 중이면 정리(수동/음성 수락 공통)
    toast.success(t("recommend.acceptStart"));
    recordActiveTrip({
      id: rec.facility.id, name: rec.facility.name, type: rec.facility.type,
      latitude: rec.facility.latitude, longitude: rec.facility.longitude,
    }, { recommendationId: rec.recommendationId, walkMinutes: rec.breakdown.travelTime, context: loadTravelContext() as unknown as Record<string, unknown>, navigationMode });
    track('navigation_started', {
      facility_type: rec.facility.type,
      navigation_mode: navigationMode,
      walk_minutes: Math.round(rec.breakdown.travelTime),
    });
    if (navigationMode === 'walk') {
      toast.info(t('trip.selectWalking'));
      openWalkingDirections(rec.facility);
    } else {
      toast.info(t('trip.driveBasisHint'));
      openDrivingDirections(rec.facility);
    }
    try {
      await submitFeedback(rec.recommendationId, "accepted_visit_intent");
    } catch (err) {
      console.warn("Error submitting accepted feedback:", err);
    }
  };

  const needsHoursCheck = (rec: RecommendationResponse) =>
    rec.openStatusAtArrival === 'needs_confirmation'
    && (rec.facility.type === 'cafe' || rec.facility.type === 'restaurant');

  const kakaoDetailsUrl = (rec: RecommendationResponse) => {
    const features = rec.facility.features as Record<string, unknown> | null | undefined;
    const placeId = String(features?.kakaoPlaceId ?? features?.kakao_place_id ?? '').trim();
    const storedUrl = String(features?.kakaoPlaceUrl ?? features?.kakao_place_url ?? '').trim();
    if (storedUrl) return storedUrl.replace(/^http:\/\/place\.map\.kakao\.com/i, 'https://place.map.kakao.com');
    if (placeId) return `https://place.map.kakao.com/${placeId}`;
    return `https://map.kakao.com/?q=${encodeURIComponent(`${rec.facility.name} ${rec.facility.address ?? '경주'}`)}`;
  };

  const requestAccept = (rec: RecommendationResponse, navigationMode: 'walk' | 'car' = 'walk') => {
    if (!needsHoursCheck(rec)) {
      void handleAccept(rec, navigationMode);
      return;
    }
    quietAssistant();
    setHoursPrompt({ recommendationId: rec.recommendationId, navigationMode });
    setHoursSubmitError(false);
    window.open(kakaoDetailsUrl(rec), '_blank', 'noopener,noreferrer');
  };

  const submitHoursStatus = async (rec: RecommendationResponse, status: 'open' | 'closed') => {
    if (hoursSubmitting) return;
    setHoursSubmitting(true);
    setHoursSubmitError(false);
    try {
      const result = await reportFacilityAvailability(rec.facility.id, status);
      setHoursPrompt(null);
      if (status === 'closed') {
        setRecommendations((current) => current.filter(
          (item) => item.recommendationId !== rec.recommendationId,
        ));
        toast.info(t('card.hoursClosedRemoved'));
        return;
      }
      const confirmed: RecommendationResponse = {
        ...rec,
        openStatusAtArrival: 'open_expected',
        facility: { ...rec.facility, availabilityEvidence: result },
      };
      setRecommendations((current) => current.map((item) => (
        item.recommendationId === rec.recommendationId ? confirmed : item
      )));
      await handleAccept(confirmed, hoursPrompt?.navigationMode ?? 'walk');
    } catch {
      setHoursSubmitError(true);
    } finally {
      setHoursSubmitting(false);
    }
  };

  // 추천 카드별 만족도 피드백(👍/👎) → helpful / not_helpful. 추천 품질 신호일 뿐이므로 선호 벡터는
  // 건드리지 않는다 — 예전엔 accepted/rejected 로 보내 '보기엔 좋았다'는 신호가 방문 수락과 같은 +10%,
  // '별로'가 명시 거절과 같은 -5% 로 학습돼 벡터를 오염시켰다(감사 P1-1).
  // 목업/합성 추천은 DB 행이 없어 서버 호출을 건너뛰고 UI 상태/토스트만 갱신한다(데모 무중단).
  const handleSatisfactionFeedback = async (rec: RecommendationResponse, vote: "up" | "down") => {
    // 동기 가드(ref): 상태 반영(리렌더) 전 빠른 연타도 차단. feedbackVotes 가드/버튼 숨김은 보조.
    if (votedRef.current.has(rec.recommendationId) || feedbackVotes[rec.recommendationId]) return;
    votedRef.current.add(rec.recommendationId);
    setFeedbackVotes((prev) => ({ ...prev, [rec.recommendationId]: vote }));
    toast.success(
      vote === "up"
        ? t("recommend.feedbackUp")
        : t("recommend.feedbackDown")
    );
    if (isSyntheticRecommendationId(rec.recommendationId)) return; // 데모/합성 추천은 서버에 기록 없음
    try {
      await submitFeedback(rec.recommendationId, vote === "up" ? "helpful" : "not_helpful");
    } catch (err) {
      console.warn("만족도 피드백 전송 실패(데모 동작에는 영향 없음):", err);
    }
  };

  // 음성 '다음' → skipped. '지금은 넘김'일 뿐 취향 거절이 아니라 학습이 없다(백엔드가 벡터를 건드리지 않음).
  // 음성 흐름을 막지 않도록 fire-and-forget — 전송 결과와 무관하게 다음 카드로 진행한다.
  const sendSkipped = (rec: RecommendationResponse) => {
    if (isSyntheticRecommendationId(rec.recommendationId)) return;
    if (skippedRef.current.has(rec.recommendationId)) return;
    skippedRef.current.add(rec.recommendationId);
    submitFeedback(rec.recommendationId, "skipped").catch((err) => {
      console.warn("건너뛰기 피드백 전송 실패(데모 동작에는 영향 없음):", err);
    });
  };

  // "다른 대안 보기" Click: Reject current top 3, fetch next 3
  const handleRejectAllAndRefresh = async () => {
    if (recommendations.length === 0 || !facilityId) return;
    quietAssistant(); // 음성 비서 진행 중이면 정리(수동/음성 새로고침 공통)
    setIsRefreshing(true);
    try {
      // 1. 보이던 묶음 전체를 dismissed_batch 로 전송 — '이 목록 말고 다른 걸 보여줘'는 개별 장소에 대한
      //    명시 거절이 아니다. 예전엔 rejected 로 보내 화면에 뜬 것만으로 3곳 전부 -5% 감점되던 문제(감사 P1-1).
      //    목업/합성 id 는 DB 기록이 없어 404 이므로 스킵하고, 개별 실패도 allSettled 로 삼켜
      //    한 건 실패가 전체를 깨뜨리지 않게 한다(handleSatisfactionFeedback 과 대칭).
      await Promise.allSettled(
        recommendations
          .filter((rec) => !isSyntheticRecommendationId(rec.recommendationId))
          .map((rec) => submitFeedback(rec.recommendationId, "dismissed_batch"))
      );

      // 2. 새 추천 시도. 실패해도 전체 흐름을 깨지 않고 빈 추천(빈 상태 UI)으로 처리한다(실데이터 전용).
      try {
        const fresh = await getRecommendations(facilityId, { lat, lng }, loadTravelContext());
        setRecommendations(fresh);
        setLoadFailed(false);
      } catch (e) {
        console.warn("refresh fetch failed, showing empty recommendations:", e);
        setRecommendations([]);
        setLoadFailed(true);
      }
      toast.success(t("recommend.refreshed"));
    } catch (err) {
      console.warn("Error during rejecting and refreshing:", err);
      toast.error(t("recommend.refreshError"));
    } finally {
      setIsRefreshing(false);
    }
  };

  // ───────────────────────── 음성 비서 헬퍼 ─────────────────────────
  // (forward 참조는 모두 이벤트/타이머에서 실행되므로 런타임에 안전 — 컴포넌트 본문이 끝난 뒤 호출됨)
  const pickKoVoice = () => {
    const vs = voicesRef.current || [];
    return (
      vs.find((v) => v.lang === "ko-KR") ||
      vs.find((v) => (v.lang || "").toLowerCase().startsWith("ko")) ||
      null
    );
  };

  // 한 문장 발화. 상태 전이는 호출자가 관리. onEnd는 정상/오류/미지원/음소거 모두에서 호출(흐름 보장).
  const speak = (text: string, onEnd?: () => void) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window) || mutedRef.current) {
      onEnd?.();
      return;
    }
    try {
      window.speechSynthesis.cancel(); // 이전 큐 비움(중복/겹침 발화 방지)
      const u = new SpeechSynthesisUtterance(text.slice(0, 300));
      u.lang = "ko-KR";
      u.rate = 1.05;
      u.pitch = 1.0;
      const v = pickKoVoice();
      if (v) u.voice = v;
      u.onend = () => onEnd?.();
      u.onerror = () => onEnd?.();
      window.speechSynthesis.speak(u);
    } catch {
      onEnd?.();
    }
  };

  const clearListenTimeout = () => {
    if (listenTimeoutRef.current) {
      clearTimeout(listenTimeoutRef.current);
      listenTimeoutRef.current = null;
    }
  };

  // 발화 종료 후 STT 시작 예약(추적되는 타이머 — quietAssistant가 정리). 0.5s 지연으로 스피커 잔향 self-trigger 방지.
  const scheduleListen = () => {
    if (speakFollowupRef.current) clearTimeout(speakFollowupRef.current);
    if (voiceStateRef.current === "idle") return;
    speakFollowupRef.current = window.setTimeout(() => {
      speakFollowupRef.current = null;
      if (voiceStateRef.current !== "idle") startAssistantListening();
    }, 500);
  };

  const finishAssistant = (text?: string) => {
    clearListenTimeout();
    if (speakFollowupRef.current) { clearTimeout(speakFollowupRef.current); speakFollowupRef.current = null; }
    try { assistantRecRef.current?.abort?.(); } catch { /* noop */ }
    startingRef.current = false;
    repromptCountRef.current = 0;
    voiceStateRef.current = "idle";
    setVoiceState("idle");
    setAssistantActive(false);
    setLiveTranscript("");
    setSpokenCaption("");
    if (text) speak(text);
    else if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
  };

  const advanceOrFinish = (fromIndex?: number) => {
    const recs = recommendationsRef.current;
    const base = fromIndex ?? activeRecIndexRef.current;
    const next = base + 1;
    if (next < recs.length) {
      repromptCountRef.current = 0;
      speakCard(next);
    } else {
      finishAssistant(t("recommend.voiceAllDone"));
    }
  };

  const handleNoResponse = () => {
    if (voiceStateRef.current === "idle") return;
    if (repromptCountRef.current < 1) {
      repromptCountRef.current += 1;
      const msg = t("recommend.voiceReprompt");
      setVoice("speaking");
      setSpokenCaption(msg);
      speak(msg, () => scheduleListen());
    } else {
      repromptCountRef.current = 0;
      advanceOrFinish();
    }
  };

  // cardIndex = 이 응답이 가리키는 카드(듣기 세션 시작 시 고정). activeRecIndexRef를 다시 읽지 않아 stale 방지.
  const handleVoiceIntent = (alts: string[], cardIndex: number) => {
    if (voiceStateRef.current === "idle") return;
    setVoice("thinking");
    repromptCountRef.current = 0;
    const recs = recommendationsRef.current;
    const rec = recs[cardIndex];
    if (!rec) {
      finishAssistant();
      return;
    }
    const sayThen = (msg: string, then: () => void) => {
      setVoice("speaking");
      setSpokenCaption(msg);
      speak(msg, then);
    };
    const intent = classifyIntent(alts);
    switch (intent) {
      case "cancel":
        finishAssistant(t("recommend.voiceEnd"));
        break;
      case "rejectAll":
        // 확인 멘트를 끝까지 들려준 뒤 새로고침(직후 호출하면 그 핸들러의 quietAssistant가 발화를 끊음).
        sayThen(t("recommend.voiceFindNew"), () => handleRejectAllAndRefresh());
        break;
      case "accept":
        // 확인 멘트를 끝까지 들려준 뒤 길안내(onEnd 시점엔 발화가 끝나 handleAccept의 cancel이 무해).
        sayThen(t("recommend.voiceGuiding"), () => requestAccept(rec));
        break;
      case "detail": {
        const waitTime = rec.breakdown?.waitTime;
        const travelTime = String(displayWalkingMinutes(rec.breakdown?.travelTime, rec.distanceM));
        const preferencePct = Math.round((rec.breakdown?.preference || 0) * 100);
        sayThen(
          t(waitTime == null ? "recommend.voiceDetailNoWait" : "recommend.voiceDetail", {
            wait: waitTime == null ? '' : waitTime.toFixed(1),
            travel: travelTime,
            pref: preferencePct,
          }),
          () => scheduleListen()
        );
        break;
      }
      case "negative":
        handleSatisfactionFeedback(rec, "down");
        sayThen(t("recommend.voiceThanksNext"), () => advanceOrFinish(cardIndex));
        break;
      case "next":
        // 음성 '다음' = skipped(학습 없음). 'negative'(별로)와 달리 품질 신호조차 아니다.
        sendSkipped(rec);
        sayThen(t("recommend.voiceNext"), () => advanceOrFinish(cardIndex));
        break;
      default: // unknown
        handleNoResponse();
    }
  };

  const startAssistantListening = () => {
    if (typeof window === "undefined") return;
    if (voiceStateRef.current === "idle") return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      // STT 미지원: 발화는 끝났고 카드 버튼으로 응답 유도(자막 안내). 권한 루프 없음.
      setSttSupported(false);
      setVoice("listening");
      setLiveTranscript("");
      return;
    }
    if (startingRef.current) return;
    startingRef.current = true;
    const idxForThisListen = activeRecIndexRef.current; // 이 듣기 세션이 묻는 카드 인덱스를 고정(stale 방지)
    try { assistantRecRef.current?.abort?.(); } catch { /* noop */ }
    try {
      const rec = new SR();
      rec.lang = "ko-KR";
      rec.interimResults = true; // 부분 인식 자막
      rec.continuous = false;
      rec.maxAlternatives = 3; // 키워드 매칭 폭 확대(하나라도 매칭되면 채택)
      rec.onresult = (e: SpeechRecognitionEvent) => {
        let interim = "";
        let finalAlts: string[] | null = null;
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) {
            finalAlts = [];
            for (let j = 0; j < r.length; j++) finalAlts.push(r[j].transcript);
          } else {
            interim += r[0]?.transcript || "";
          }
        }
        if (interim) setLiveTranscript(interim);
        if (finalAlts) {
          if (voiceStateRef.current !== "listening") return; // thinking/acting 중 추가 final 무시
          clearListenTimeout();
          setLiveTranscript(finalAlts[0] || "");
          handleVoiceIntent(finalAlts, idxForThisListen);
        }
      };
      rec.onerror = (e: SpeechRecognitionErrorEvent) => {
        startingRef.current = false;
        clearListenTimeout();
        const err = e?.error;
        if (err === "not-allowed" || err === "service-not-allowed") {
          setSttSupported(false);
          toast.info(t("recommend.micDenied"));
          voiceStateRef.current = "idle";
          setVoiceState("idle");
          setAssistantActive(false); // 권한 거부 시 비서 종료(assistantActive=true로 남는 UI 불일치 방지)
          setSpokenCaption("");
          return;
        }
        if (voiceStateRef.current === "listening") handleNoResponse(); // no-speech/aborted
      };
      rec.onend = () => {
        startingRef.current = false;
      };
      assistantRecRef.current = rec;
      setVoice("listening");
      setLiveTranscript("");
      rec.start();
      clearListenTimeout();
      listenTimeoutRef.current = window.setTimeout(() => {
        try { assistantRecRef.current?.stop?.(); } catch { /* noop */ }
        if (voiceStateRef.current === "listening") handleNoResponse();
      }, 7000); // 무응답 7초 → 재안내(1회) → 소극 진행
    } catch {
      startingRef.current = false;
      handleNoResponse();
    }
  };

  const speakCard = (index: number) => {
    const recs = recommendationsRef.current;
    if (!recs || index < 0 || index >= recs.length) {
      finishAssistant();
      return;
    }
    setActiveRec(index);
    const rec = recs[index];
    const localizedFallback = buildFallbackReason(
        t,
        rec.facility.name,
        typeof rec.breakdown?.waitTime === 'number' ? rec.breakdown.waitTime : null,
        rec.distanceM,
        // 원시 congestionLevel 이 아니라 '지금 주장해도 되는' 값 — 배지와 문장(그리고 음성)이
        // 다른 말을 하지 않게 한다. 서버는 한국어 사유에서 이미 같은 판단을 한다.
        assertableCongestionLevel(rec),
      );
    const reasonText = locale === 'ko' && rec.reason ? rec.reason : localizedFallback;
    const sentence = buildCardSpeech(rec.facility.name, reasonText, index);
    setVoice("speaking");
    setSpokenCaption(sentence); // 발화 텍스트를 자막으로(청각 정보 시각 동시 제공 + 추천 사유 가시화)
    speak(sentence, () => scheduleListen());
  };

  // 제스처 게이트: 오브/칩 onClick 콜백 동기 스택 안에서 첫 발화 → 자동재생 정책 통과.
  const startAssistant = () => {
    if (typeof window === "undefined") return;
    if (!("speechSynthesis" in window)) {
      toast.info(t("recommend.ttsUnsupported"));
      return;
    }
    if (!recommendationsRef.current.length) return;
    voiceUnlockedRef.current = true;
    mutedRef.current = false;
    setAssistantMuted(false);
    setAssistantActive(true);
    repromptCountRef.current = 0;
    try {
      const warm = new SpeechSynthesisUtterance(" "); // audio context 워밍업(첫 발화 누락 방지)
      warm.volume = 0;
      window.speechSynthesis.speak(warm);
    } catch { /* noop */ }
    speakCard(0);
  };

  const onOrbClick = () => {
    if (!assistantActive) {
      startAssistant();
      return;
    }
    // 발화 중 탭 = 바지인(말 끊고 바로 듣기)
    if (voiceStateRef.current === "speaking") {
      if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
      startAssistantListening();
      return;
    }
    quietAssistant();
  };

  const toggleAssistantMute = () => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setAssistantMuted(next);
    if (next && typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      // 발화 중 음소거 시 utterance.onend가 안 와 흐름이 멈출 수 있으니 곧바로 듣기로 전환(STT는 유지).
      if (voiceStateRef.current === "speaking") {
        if (speakFollowupRef.current) { clearTimeout(speakFollowupRef.current); speakFollowupRef.current = null; }
        startAssistantListening();
      }
    }
  };

  const getTypeName = (type: string) => {
    switch (type) {
      case "restaurant":
        return t("category.restaurant");
      case "cafe":
        return t("category.cafe");
      case "attraction":
        return t("category.attraction");
      case "culture":
        return t("category.culture");
      default:
        return t("course.typeFallback");
    }
  };

  // 카테고리 칩: id 는 로직 키(선택·저장·백엔드), 표시명은 category.* 사전에서, 이모지는 디자인 유지.
  const categoriesList = [
    { id: "restaurant", labelKey: "category.restaurant", emoji: "🍴" },
    { id: "cafe", labelKey: "category.cafe", emoji: "☕" },
    { id: "attraction", labelKey: "category.attraction", emoji: "📸" },
    { id: "culture", labelKey: "category.culture", emoji: "🏛️" },
  ];

  // facilityId 없이 마운트가 끝났다면(깨진 공유 링크·URL 직접 입력) 데이터 로드 이펙트가 전부
  // `if (!facilityId) return;` 로 빠져 영구 스켈레톤에 갇힌다 — 대신 안내 빈 상태 + 지도로 돌아가는 CTA 를 보여준다.
  // /explore/map 은 /main 으로 리다이렉트되는 구 경로일 뿐이라, 헤더의 "지도 보기"(위 backToMap)와 동일하게 /main 으로 보낸다.
  if (mounted && !facilityId) {
    return (
      <main className="min-h-screen bg-hanji text-muk p-4 md:p-8 flex flex-col items-center justify-center relative overflow-hidden">
        <div className="absolute top-[-20%] left-[-10%] w-[600px] h-[600px] rounded-full bg-sunset-1/10 blur-[120px] pointer-events-none" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[600px] h-[600px] rounded-full bg-gold/10 blur-[120px] pointer-events-none" />
        <div className="bg-white p-8 rounded-2xl border border-line toss-surface flex flex-col items-center text-center w-full max-w-[320px] relative z-10">
          <div className="w-16 h-16 rounded-full bg-gradient-to-b from-gold/20 to-gold/10 border border-line flex items-center justify-center mb-6 text-2xl">
            🧭
          </div>
          <h2 className="text-lg font-serif font-bold text-muk mb-2">{t("recommend.noFacilityTitle")}</h2>
          <p className="text-muk-soft text-sm leading-relaxed mb-6 px-1">{t("recommend.noFacilityDesc")}</p>
          <button
            type="button"
            onClick={() => router.push("/main")}
            className="toss-pressable min-h-11 w-full flex items-center justify-center py-2.5 bg-gradient-to-r from-gold to-terracotta text-white rounded-xl font-bold text-xs transition-opacity duration-300 hover:opacity-90 shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
          >
            {t("recommend.backToMap")}
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-hanji text-muk p-4 md:p-8 max-md:pb-[calc(var(--tourist-nav-clearance)+env(safe-area-inset-bottom))] flex flex-col justify-between items-center relative overflow-hidden">
      {/* 배경 은은한 노을·금빛 광원 (콜드 blue/purple 글로우 대체) */}
      <div className="absolute top-[-20%] left-[-10%] w-[600px] h-[600px] rounded-full bg-sunset-1/10 blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[600px] h-[600px] rounded-full bg-gold/10 blur-[120px] pointer-events-none" />

      <div className="w-full max-w-md md:max-w-2xl space-y-6 relative z-10 flex-1 py-4">
        {/* Header */}
        <header className="flex items-center justify-between border-b border-line pb-4">
          <button
            type="button"
            onClick={() => { quietAssistant(); router.push("/main"); }}
            className="toss-pressable -ml-2 flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muk-soft transition-colors hover:text-muk focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
          >
            ← {t("recommend.backToMap")}
          </button>
          <span className="text-sm font-extrabold tracking-tight gradient-text">{t("recommend.headerBrand")}</span>
          <div className="w-14"></div> {/* spacer */}
        </header>

        {/* 1. Original Facility Card */}
        <section>
          {loadingOriginal ? (
            <div className="bg-white p-6 rounded-2xl border border-line toss-surface animate-pulse flex flex-col gap-3">
              <div className="h-4 bg-hanji-deep w-2/3 rounded-md" />
              <div className="h-3 bg-hanji-deep w-1/2 rounded-md" />
            </div>
          ) : originalFacility ? (
            (() => {
              // 정직성: 헤드라인은 실측 혼잡도를 따른다 — 이전엔 진입 경로와 무관하게 '혼잡합니다'
              // 템플릿을 고정 출력해 대기 보드('한산·대기 1분')와 모순된 안내가 나갔다(사용자 신고 버그).
              // 로그 0건(congestionLevel=null)은 '여유'로도 팔지 않는다 — 중립 카드(CONGESTION_TRUST_SPEC).
              if (originalFacility.congestionLevel === null) {
                return (
                  <div className="bg-white p-6 rounded-2xl border border-line toss-surface relative overflow-hidden">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-muk-soft/40" />
                      <span className="text-[10px] text-muk-soft font-bold tracking-wider">
                        {t("card.congestionPreparing")}
                      </span>
                    </div>
                    <h2 className="text-xl md:text-2xl font-serif font-bold text-muk tracking-tight mt-2.5 leading-snug">
                      <span>{originalFacility.name}</span>
                      {t("recommend.unknownSuffix")}
                    </h2>
                    <p className="text-xs text-muk-soft mt-1.5 leading-relaxed">{t("recommend.unknownHint")}</p>
                  </div>
                );
              }
              const crowded = originalFacility.congestionLevel >= 0.6;
              return (
                <div className={`bg-white p-6 rounded-2xl border ${crowded ? "border-terracotta/25" : "border-jade/25"} toss-surface relative overflow-hidden`}>
                  <div className={`absolute top-0 right-0 w-24 h-24 ${crowded ? "bg-terracotta/10" : "bg-jade/10"} rounded-full blur-2xl pointer-events-none`} />
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${crowded ? "bg-terracotta animate-pulse" : "bg-jade"}`} />
                    <span className={`text-[10px] ${crowded ? "text-terracotta" : "text-jade"} font-bold tracking-wider`}>
                      {crowded ? t("recommend.detourNeeded") : t("recommend.calmBadge")}
                    </span>
                  </div>
                  <h2 className="text-xl md:text-2xl font-serif font-bold text-muk tracking-tight mt-2.5 leading-snug">
                    {t("recommend.congestedPrefix")}
                    <span className={crowded ? "text-terracotta" : "text-jade"}>{originalFacility.name}</span>
                    {crowded ? t("recommend.congestedSuffix") : t("recommend.calmSuffix")}
                  </h2>
                  <p className="text-xs text-muk-soft mt-1.5 leading-relaxed">
                    {t("recommend.waitUnavailable")}
                  </p>
                  {!crowded && (
                    <p className="text-xs text-muk-soft mt-1 leading-relaxed">{t("recommend.calmHint")}</p>
                  )}
                </div>
              );
            })()
          ) : (
            <div className="bg-white p-5 rounded-2xl border border-line toss-surface text-center text-xs text-muk-soft">
              {t("recommend.facilityLoadError")}
            </div>
          )}
        </section>

        {/* 2. Alternative Recommendation Cards List */}
        <section className="space-y-4">
          <h3 className="text-sm font-bold text-muk">{t("recommend.altListTitle")}</h3>

          {loadingRecommendations ? (
            // Skeleton Loader
            [1, 2, 3].map((idx) => (
              <div key={idx} className="bg-white p-5 rounded-2xl border border-line toss-surface animate-pulse flex flex-col gap-3">
                <div className="flex justify-between items-center">
                  <div className="h-4 bg-hanji-deep w-1/3 rounded-md" />
                  <div className="h-4 bg-hanji-deep w-16 rounded-full" />
                </div>
                <div className="h-24 bg-hanji-deep/60 rounded-xl w-full" />
                <div className="h-3 bg-hanji-deep w-2/3 rounded-md" />
                <div className="h-10 bg-hanji-deep w-full rounded-xl mt-1" />
              </div>
            ))
          ) : recommendations.length > 0 ? (
            <>
            <RecommendationComparison recommendations={recommendations} />
            {recommendations.map((rec, idx) => {
              const waitTime = rec.breakdown?.waitTime?.toFixed(1) || "--";
              const travelTime = displayWalkingMinutes(rec.breakdown?.travelTime, rec.distanceM);
              const arrivalDisplayStatus = rec.openStatusAtArrival
                ? getArrivalOpenDisplayStatus(
                    rec.openStatusAtArrival,
                    rec.facility.type,
                    new Date(Date.now() + travelTime * 60_000),
                  )
                : null;
              const preferencePct = Math.round((rec.breakdown?.preference || 0) * 100);
              const isVoiceActive = assistantActive && idx === activeRecIndex; // 음성 비서가 지금 안내 중인 카드
              // TourAPI 상세 소비(RecommendationCard 와 동일 관례) — features 내부 키는 keysToCamel 재귀
              // 변환(firstMenu)과 supabase 폴백 원본(first_menu) 두 표기를 모두 방어한다.
              const recFeatures = rec.facility.features as Record<string, unknown> | null | undefined;
              const firstMenuRaw = (recFeatures?.firstMenu ?? recFeatures?.first_menu) as string | undefined;
              const firstMenuTokens = firstMenuRaw
                ? firstMenuRaw.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 2)
                : [];
              // 오늘 휴무 — 보수 파서 확정(true)일 때만 배지(과판정 금지 원칙).
              const closedToday =
                isClosedToday((recFeatures?.restDateRaw ?? recFeatures?.rest_date_raw) as string | undefined) === true;
              const freshness = relativeParts(rec.congestionTimestamp ?? rec.dataUpdatedAt);
              // 무엇을 '지금' 으로 칠할지 — 추천 카드·코스와 **같은 함수**로 정한다
              // (lib/congestionEstimate.ts congestionDisplay). 이 화면이 따로 판정하지 않는다.
              // 추정은 '지금' 자격이 있는 실측·예측이 없을 때만 — 대기 분·인원은 만들지 않는다.
              const display = congestionDisplay(rec);
              const estimate = display.estimate;
              // 추정에 자리를 내줬거나 대신할 추정이 없어 그대로 칠한 '낡은 관측'. 지우지 않는다.
              const lastObserved = display.lastObserved;
              const shownLevel =
                display.mode === 'measured' || display.mode === 'predicted' ? display.level : null;
              // 등급은 운영자 '혼잡' 경계(busyAt)로 — 지도 점선 핀·코스 칩과 같은 말을 해야 한다.
              const estimateKey = estimate ? congestionKey(estimate.level, busyAt) : null;
              const freshnessText = freshness
                ? freshness.unit === 'now' ? t('freshness.justNow')
                  : freshness.unit === 'min' ? t('freshness.minAgo', { n: freshness.value })
                  : freshness.unit === 'hour' ? t('freshness.hourAgo', { n: freshness.value })
                  : t('freshness.dayAgo', { n: freshness.value })
                : null;
              const localizedReason = buildFallbackReason(
                t,
                rec.facility.name,
                typeof rec.breakdown?.waitTime === 'number' ? rec.breakdown.waitTime : null,
                rec.distanceM,
                assertableCongestionLevel(rec),   // 배지와 같은 판정(위 helper 주석 참조)
              );
              const displayReason = locale === 'ko' && rec.reason ? rec.reason : localizedReason;
              const spotComparison = spotComparisonById.get(rec.recommendationId);

              return (
                <div
                  key={rec.recommendationId}
                  className={`bg-white p-5 rounded-2xl border transition-all duration-300 toss-surface ${
                    isVoiceActive
                      ? "border-gold ring-2 ring-gold/40 scale-[1.02]"
                      : "border-line hover:border-gold/40 hover:scale-[1.01]"
                  }`}
                >
                  {/* 시설 사진 — TourAPI firstimage(이미 응답에 실려 옴). 정적 export 라 raw img 사용
                      (대기 보드 WaitingCardImage 와 동일 관례). 로드 실패 시 상태 없이 요소만 숨겨
                      레이아웃이 깨지지 않는다. */}
                  {rec.facility.imageUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={rec.facility.imageUrl}
                      alt={rec.facility.name}
                      loading="lazy"
                      onError={(e) => { e.currentTarget.style.display = 'none'; }}
                      className="w-full h-36 object-cover rounded-xl border border-line mb-4"
                    />
                  )}
                  {/* Top info row */}
                  <div className="flex justify-between items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[10px] font-bold text-jade bg-jade/10 border border-jade/30 px-2 py-0.5 rounded-md">
                        {getTypeName(rec.facility.type)}
                      </span>
                      {/* 오늘 휴무 배지 — RecommendationCard(/main)와 동일 톤(terracotta), 확정 시에만. */}
                      {closedToday && (
                        <span className="text-[10px] font-bold text-terracotta bg-terracotta/10 border border-terracotta/30 px-2 py-0.5 rounded-md">
                          {t("card.closedToday")}
                        </span>
                      )}
                      {arrivalDisplayStatus && (
                        <span className={`text-[10px] font-bold border px-2 py-0.5 rounded-md ${
                          arrivalDisplayStatus === "open_expected"
                            ? "text-jade bg-jade/10 border-jade/30"
                            : arrivalDisplayStatus === "closing_soon" || arrivalDisplayStatus === "likely_closed_unknown"
                              ? "text-terracotta bg-terracotta/10 border-terracotta/30"
                              : "text-muk-soft bg-hanji-deep border-line"
                        }`}>
                          {t(`card.arrivalStatus.${arrivalDisplayStatus}`)}
                        </span>
                      )}
                      {rec.rank && rec.totalCandidates && (
                        <span className="text-[10px] font-bold text-gold-deep bg-gold/10 border border-gold/30 px-2 py-0.5 rounded-md">
                          {t("recommend.rankOfTotal", { total: rec.totalCandidates, rank: rec.rank })}
                        </span>
                      )}
                      {/* 혼잡 3단계 근거 배지(CONGESTION_TRUST_SPEC): 실측 4단계 pill / AI 예측 / 준비 중.
                          색·임계는 RecommendationCard 혼잡 pill 과 동일 규약(0.75/0.5/0.25). */}
                      {display.mode === "measured" && shownLevel !== null && (
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md border ${
                          shownLevel >= 0.75
                            ? "bg-terracotta/10 border-terracotta/30 text-terracotta"
                            : shownLevel >= 0.5
                            ? "bg-gold/10 border-gold/30 text-gold-deep"
                            : shownLevel >= 0.25
                            ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-600"
                            : "bg-jade/10 border-jade/30 text-jade"
                        }`}>
                          {t("card.congestion")}: {t(`congestion.${
                            shownLevel >= 0.75 ? "busy" : shownLevel >= 0.5 ? "moderate" : shownLevel >= 0.25 ? "relaxed" : "quiet"
                          }`)}
                        </span>
                      )}
                      {display.mode === "predicted" && shownLevel !== null && (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-md border bg-sky-500/10 border-sky-500/30 text-sky-700">
                          {t("map.forecast")} · {Math.round(shownLevel * 100)}%
                        </span>
                      )}
                      {estimate && estimateKey ? (
                        <>
                          {/* 점선·옅은 바탕 — 위 실측 pill 의 꽉 찬 등급색과 한눈에 달라야 한다. */}
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md border border-dashed bg-white/70 ${
                            estimateKey === "busy"
                              ? "border-terracotta/60 text-terracotta"
                              : estimateKey === "moderate"
                              ? "border-gold/60 text-gold-deep"
                              : estimateKey === "relaxed"
                              ? "border-emerald-500/60 text-emerald-700"
                              : "border-jade/60 text-jade"
                          }`}>
                            {t("card.estimateLevel", { label: t(`congestion.${estimateKey}`) })}
                          </span>
                          <span className="text-[10px] font-medium px-2 py-0.5 rounded-md border border-dashed border-line text-muk-soft">
                            {/* 보정이 실제로 적용된 값이면 같은 칩 안에서 한 마디만 더 — 새 배지는 만들지 않는다. */}
                            {t(estimate.calibrated ? "card.evidenceEstimatedCalibrated" : "card.evidenceEstimated", {
                              time: formatEstimateTime(estimate.observedAt) ?? "—",
                              km: estimateRadiusKm(estimate.radiusM),
                            })}
                          </span>
                        </>
                      ) : display.mode === "none" && (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-md border bg-muk/5 border-line text-muk-soft">
                          {t("card.congestionPreparing")}
                        </span>
                      )}
                      {/* '지금' 자격을 잃은 관측은 지우지 않고 맥락으로 남긴다(마지막 관측 시각).
                          등급색을 쓰지 않는 이유: 이 칩은 '지금' 을 주장하지 않는다. */}
                      {lastObserved && (
                        <span className="text-[10px] font-medium px-2 py-0.5 rounded-md border border-dashed border-line text-muk-soft">
                          {typeof lastObserved.level === "number"
                            ? t("card.lastObservedLevel", {
                                time: formatLastObserved(lastObserved.observedAt) ?? "—",
                                label: t(`congestion.${congestionKey(lastObserved.level, busyAt)}`),
                              })
                            : t("card.lastObserved", {
                                time: formatLastObserved(lastObserved.observedAt) ?? "—",
                              })}
                        </span>
                      )}
                      {/* D-3: 합성(seed)/시뮬(simulated) 로그는 데모 데이터임을 UI 라벨로 구분(가드레일). */}
                      {rec.congestionSource === "measured" &&
                        (rec.congestionLogSource === "seed" || rec.congestionLogSource === "simulated") && (
                        <span className="text-[10px] font-medium px-2 py-0.5 rounded-md border bg-hanji-deep border-line text-muk-soft">
                          {t("card.demoData")}
                        </span>
                      )}
                      {/* 24시간 배지는 '마지막 관측' 칩이 없을 때만 — 같은 말을 두 번 하지 않는다
                          (구 서버 응답처럼 '지금' 판정이 없을 때 남는 경로다). */}
                      {rec.congestionSource === "measured" && rec.congestionIsStale && !lastObserved && (
                        <span className="text-[10px] font-medium px-2 py-0.5 rounded-md border bg-hanji-deep border-line text-muk-soft/70">
                          {t("card.freshStale")}
                        </span>
                      )}
                      {isVoiceActive && voiceState !== "idle" && (
                        <span className="text-[10px] font-bold text-jade bg-jade/10 border border-jade/30 px-2 py-0.5 rounded-md inline-flex items-center gap-1 align-middle">
                          {voiceState === "speaking" ? t("recommend.stateSpeaking") : voiceState === "listening" ? t("recommend.stateListening") : t("recommend.stateThinking")}
                        </span>
                      )}
                      </div>
                      <h4 className="text-lg md:text-xl font-extrabold text-muk tracking-tight mt-2 leading-snug break-words">
                        {rec.facility.name}
                      </h4>
                      {/* lastObserved 가 있으면 위 칩이 이미 '언제' 를 말했다 — 'n일 전 기준' 을 또 쓰면
                          지금 칠해진 값(추정)이 n일 전 값으로 읽힌다. */}
                      {rec.congestionSource !== 'none' && freshnessText && !lastObserved && (
                        <p className="mt-1 text-[10px] text-muk-soft">
                          {rec.congestionLogSource === 'user_report'
                            ? t('card.freshReport', { rel: freshnessText })
                            : t('card.freshLive', { rel: freshnessText })}
                        </p>
                      )}
                      {rec.placeDataSource === 'localdata' && (
                        <p className="mt-1 text-[10px] text-muk-soft">
                          {t('card.publicLicenseSource', {
                            date: rec.dataUpdatedAt
                              ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(rec.dataUpdatedAt))
                              : t('card.sourceDateUnknown'),
                          })}
                        </p>
                      )}
                      {/* 공식 대표 메뉴(TourAPI first_menu) — 있을 때만, 앞 2개('지어내지 않기'). */}
                      {firstMenuTokens.length > 0 && (
                        <p className="mt-1 text-[11px] text-muk-soft">
                          <span className="font-bold text-gold-deep">{t("card.signatureMenu")}</span>
                          {" · "}
                          {firstMenuTokens.join(" · ")}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-col items-center justify-center rounded-xl border border-gold/25 bg-gold/5 px-3 py-2 text-center">
                      <span className="text-[9px] font-bold uppercase tracking-wide text-muk-soft whitespace-nowrap">{t("recommend.spotIndex")}</span>
                      <span className="text-base font-extrabold text-gold-deep leading-none mt-1">
                        {Math.round(rec.spotScore <= 1.0 ? rec.spotScore * 100 : rec.spotScore)}{t("card.pointSuffix")}
                      </span>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-col gap-3">

                  {spotComparison && (
                    <div className="rounded-xl border border-jade/20 bg-jade/5 px-3 py-2.5">
                      <p className="text-[9px] font-extrabold uppercase tracking-wide text-jade">
                        {t('recommend.spotComparison.current')}
                      </p>
                      <p className="mt-0.5 text-[11px] font-semibold leading-snug text-muk">
                        {spotComparison}
                      </p>
                    </div>
                  )}

                  {/* 백엔드 템플릿 추천 사유 (있을 때만 노출) */}
                  {displayReason && (
                    <p className="text-[11px] leading-snug text-muk bg-gold/10 border border-gold/20 rounded-xl px-3 py-2">
                      💡 {displayReason}
                    </p>
                  )}

                  {/* A4: 행사 혼잡 보정 배지 — 도착시점 인근 진행 중 축제로 예측이 가중됐을 때만 노출(투명성) */}
                  {(rec.breakdown?.eventBoost ?? 0) > 0 && (
                    <p className="text-[11px] leading-snug text-terracotta bg-terracotta/10 border border-terracotta/20 rounded-xl px-3 py-2">
                      🎪 {t("recommend.festivalAdjusted", {
                        title: rec.breakdown?.eventTitle ?? "",
                        pct: Math.round((rec.breakdown?.eventBoost ?? 0) * 100),
                      })}
                    </p>
                  )}

                  {typeof rec.breakdown?.areaDemandLevel === "number" && (
                    <div className="text-[11px] leading-snug text-sky-800 bg-sky-500/10 border border-sky-500/20 rounded-xl px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-bold">
                          {rec.breakdown.areaDemandTourismEvidence
                            ? t("recommend.areaEvidenceCount", {
                                n: Number(!!rec.breakdown.areaDemandParkingEvidence) + 1,
                              })
                            : rec.breakdown.areaDemandParkingEvidence
                              ? `${t(rec.breakdown.areaDemandParkingEvidence.mode === "forecast"
                                ? "recommend.parkingEvidenceForecast"
                                : "recommend.parkingEvidenceLive")}: ${t(`congestion.${
                                  rec.breakdown.areaDemandParkingEvidence.level >= 0.75 ? "busy"
                                    : rec.breakdown.areaDemandParkingEvidence.level >= 0.5 ? "moderate"
                                    : rec.breakdown.areaDemandParkingEvidence.level >= 0.25 ? "relaxed" : "quiet"
                                }`)}`
                              : `${t("recommend.areaDemand")}: ${t(`congestion.${
                                  rec.breakdown.areaDemandLevel >= 0.75 ? "busy"
                                    : rec.breakdown.areaDemandLevel >= 0.5 ? "moderate"
                                    : rec.breakdown.areaDemandLevel >= 0.25 ? "relaxed" : "quiet"
                                }`)}`}
                        </span>
                        {!rec.breakdown.areaDemandTourismEvidence && <span className="text-[10px] text-sky-700">
                          {t(rec.breakdown.areaDemandMode === "live"
                            ? "recommend.areaDemandLive"
                            : rec.breakdown.areaDemandMode === "forecast"
                              ? "recommend.areaDemandForecast"
                              : "recommend.areaDemandStats")}
                        </span>}
                      </div>
                      {rec.breakdown.areaDemandTourismEvidence && (
                        <p className="mt-1 text-sky-800/80">{t("recommend.areaDemandCompositeHint")}</p>
                      )}
                      {rec.breakdown.areaDemandParkingEvidence && (
                        <div className="mt-2 rounded-lg border border-sky-500/20 bg-white/55 px-2.5 py-2">
                          <p className="font-bold text-sky-900">
                            {t(rec.breakdown.areaDemandParkingEvidence.mode === "live"
                              ? "recommend.parkingEvidenceLive"
                              : "recommend.parkingEvidenceForecast")}: {t(`congestion.${
                                rec.breakdown.areaDemandParkingEvidence.level >= 0.75 ? "busy"
                                  : rec.breakdown.areaDemandParkingEvidence.level >= 0.5 ? "moderate"
                                  : rec.breakdown.areaDemandParkingEvidence.level >= 0.25 ? "relaxed" : "quiet"
                              }`)}
                          </p>
                          <p className="text-[10px] text-sky-700">
                            {typeof rec.breakdown.areaDemandParkingEvidence.radiusM === "number"
                              ? t("recommend.parkingEvidenceRadius", { n: rec.breakdown.areaDemandParkingEvidence.radiusM.toLocaleString() })
                              : t("recommend.parkingEvidenceArea")}
                          </p>
                        </div>
                      )}
                      {rec.breakdown.areaDemandTourismEvidence && (
                        <div className="mt-2 rounded-lg border border-indigo-500/20 bg-white/55 px-2.5 py-2 text-indigo-900">
                          <p className="font-bold">
                            {typeof rec.breakdown.areaDemandTourismEvidence.relativeIndex === "number"
                              ? t("recommend.tourismEvidenceIndex", { n: Math.round(rec.breakdown.areaDemandTourismEvidence.relativeIndex) })
                              : t("recommend.tourismEvidenceTitle")}
                          </p>
                          <p className="text-[10px] text-indigo-700">
                            {t("recommend.tourismEvidenceBasis", {
                              name: rec.breakdown.areaDemandTourismEvidence.referenceName ?? t("recommend.tourismReferenceUnknown"),
                              distance: typeof rec.breakdown.areaDemandTourismEvidence.distanceM === "number"
                                ? Math.round(rec.breakdown.areaDemandTourismEvidence.distanceM).toLocaleString() : "-",
                              date: rec.breakdown.areaDemandTourismEvidence.forecastDate ?? "-",
                            })}
                          </p>
                          <p className="mt-1 text-[10px] text-indigo-700/90">{t("recommend.tourismEvidenceDisclaimer")}</p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Minimap container */}
                  <div>
                    <MiniMap
                      latitude={rec.facility.latitude}
                      longitude={rec.facility.longitude}
                      mapLoaded={mapLoaded}
                    />
                  </div>

                  {/* SPOT Breakdown Indicators */}
                  <div className={`grid ${display.mode === 'none' && !estimate ? 'grid-cols-2' : 'grid-cols-3'} gap-2 py-2 border-t border-b border-line text-[11px] text-muk-soft`}>
                    <div className="text-center">
                      <span className="text-muk-soft block text-[10px]">{t("recommend.prefMatch")}</span>
                      <span className="font-bold text-jade">{preferencePct}%</span>
                    </div>
                    {/* 추정이 '지금' 자리를 가져갔으면 대기 칸은 그리지 않는다 — 그 대기 분은
                        낡은 관측에서 나온 값이라, 추정 배지 옆에 두면 두 시점이 한 줄에 섞인다.
                        (추정 자체는 대기 분을 만들지 않는다 — 점유율→대기 계수가 없다.) */}
                    {display.mode !== 'none' && !estimate && <div className="text-center border-l border-r border-line">
                      <span className="text-muk-soft block text-[10px]">{t("recommend.expectedWait")}</span>
                      <span className="font-bold text-gold-deep">{t("recommend.minutesValue", { n: waitTime })}</span>
                    </div>}
                    {/* 추정은 대기 칸을 채우지 않는다(점유율→대기 계수가 없다). 등급만 '추정' 머리표와 함께. */}
                    {estimate && estimateKey && <div className="text-center border-l border-r border-dashed border-line">
                      <span className="text-muk-soft block text-[10px]">{t("course.estimateShort")}</span>
                      <span className="font-bold text-muk-soft">{t(`congestion.${estimateKey}`)}</span>
                    </div>}
                    <div className="text-center">
                      <span className="text-muk-soft block text-[10px]">{t("recommend.expectedWalk")}</span>
                      <span className="font-bold text-jade">{t("recommend.walkValue", { n: travelTime, dist: Math.round(rec.distanceM) })}</span>
                    </div>
                  </div>

                  {/* 만족도 피드백 (👍/👎) — 선호 벡터를 보정해 다음 추천에 반영 */}
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] text-muk-soft">{t("recommend.feedbackQuestion")}</span>
                    {feedbackVotes[rec.recommendationId] ? (
                      <span className="text-[10px] font-semibold text-jade">
                        {feedbackVotes[rec.recommendationId] === "up" ? "👍" : "👎"} {t("recommend.feedbackApplied")}
                      </span>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleSatisfactionFeedback(rec, "up")}
                          aria-label={t("recommend.feedbackUpAria")}
                          className="toss-pressable min-h-11 px-2.5 rounded-lg text-[11px] font-semibold border bg-hanji-deep border-line text-muk-soft hover:border-jade/50 hover:text-jade focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
                        >
                          👍 {t("recommend.like")}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSatisfactionFeedback(rec, "down")}
                          aria-label={t("recommend.feedbackDownAria")}
                          className="toss-pressable min-h-11 px-2.5 rounded-lg text-[11px] font-semibold border bg-hanji-deep border-line text-muk-soft hover:border-terracotta/50 hover:text-terracotta focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
                        >
                          👎 {t("recommend.dislike")}
                        </button>
                      </div>
                    )}
                  </div>

                  {/* CTA button */}
                  {hoursPrompt?.recommendationId === rec.recommendationId && (
                    <div className="rounded-2xl border border-gold/30 bg-gold/10 p-3" role="group" aria-label={t('card.hoursCheckQuestion')}>
                      <p className="text-xs font-extrabold text-muk">{t('card.hoursCheckQuestion')}</p>
                      <p className="mt-1 text-[11px] leading-relaxed text-muk-soft">{t('card.hoursCheckPrivacy')}</p>
                      <div className="mt-3 grid grid-cols-3 gap-2">
                        <button type="button" disabled={hoursSubmitting} onClick={() => void submitHoursStatus(rec, 'open')} className="toss-pressable min-h-11 rounded-xl bg-jade px-2 py-2 text-[11px] font-bold text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 disabled:opacity-50">
                          {t('card.hoursOpen')}
                        </button>
                        <button type="button" disabled={hoursSubmitting} onClick={() => void submitHoursStatus(rec, 'closed')} className="toss-pressable min-h-11 rounded-xl bg-terracotta px-2 py-2 text-[11px] font-bold text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 disabled:opacity-50">
                          {t('card.hoursClosed')}
                        </button>
                        <button type="button" disabled={hoursSubmitting} onClick={() => { setHoursPrompt(null); setHoursSubmitError(false); }} className="toss-pressable min-h-11 rounded-xl border border-line bg-white px-2 py-2 text-[11px] font-bold text-muk-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 disabled:opacity-50">
                          {t('card.hoursUnsure')}
                        </button>
                      </div>
                      {hoursSubmitError && <p className="mt-2 text-[10px] font-semibold text-terracotta">{t('card.hoursReportFailed')}</p>}
                    </div>
                  )}

                  <div className="flex flex-col gap-2">
                    <button
                      type="button"
                      onClick={() => requestAccept(rec)}
                      className="toss-pressable min-h-11 w-full flex items-center justify-center py-2.5 bg-gradient-to-r from-gold to-terracotta text-white rounded-xl font-bold text-xs transition-opacity duration-300 hover:opacity-90 shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
                    >
                      {t("card.accept")}
                    </button>
                    <button
                      type="button"
                      onClick={() => requestAccept(rec, 'car')}
                      className="toss-pressable min-h-11 w-full flex items-center justify-center rounded-xl border border-line bg-white py-2 text-[11px] font-bold text-muk-soft hover:border-gold/40 hover:text-gold-deep focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
                    >
                      {t('card.drive')} · <span className="font-medium">{t('card.driveBasisHint')}</span>
                    </button>
                  </div>

                  <div className="flex flex-col gap-2">
                    {/* 현장 혼잡 수집 — 정보가 없는 장소일수록 CTA를 강조한다. 제보 직후에는
                        서버 재조회 없이 이 카드만 실측 상태로 갱신해 사용자의 행동 결과를 보여준다. */}
                    <div className="flex justify-center">
                      <CongestionReportButton
                        facility={{ id: rec.facility.id, name: rec.facility.name }}
                        isFirst={rec.congestionSource === 'none'}
                        className="w-full justify-center"
                        onReported={(level) => {
                          const congestionLevel = level === '한산' ? 0.2 : level === '보통' ? 0.5 : 0.8;
                          const congestionTimestamp = new Date().toISOString();
                          setRecommendations((current) => current.map((item) => (
                            item.recommendationId === rec.recommendationId
                              ? {
                                  ...item,
                                  congestionLevel,
                                  congestionSource: 'measured',
                                  congestionTimestamp,
                                  congestionLogSource: 'user_report',
                                  congestionIsStale: false,
                                  // **반드시 함께 덮어써야 한다.** 서버가 내려준 congestionIsCurrent 가
                                  // false(낡은 관측)인 채로 남으면, 방금 사용자가 눈으로 보고 남긴 제보가
                                  // '마지막 관측 14:37' 로 밀려나고 추정이 '지금' 자리를 차지한다.
                                  // 사용자가 지금 본 것보다 새로운 근거는 없다.
                                  congestionIsCurrent: true,
                                }
                              : item
                          )));
                        }}
                      />
                    </div>

                    {/* 공유 — 지금 한산한 이 장소를 퍼뜨려 자연 유입을 만든다. 링크는 같은 페이지(원 시설/좌표)로
                        돌아오되 ref=share 를 붙여 위 계측 useEffect 가 방문을 집계한다. */}
                    <div className="flex justify-center">
                      <ShareButton
                        title={t("common.appName")}
                        text={rec.facility.name}
                        shareText={t("recommend.shareText", { name: rec.facility.name })}
                        url={
                          typeof window !== "undefined"
                            ? `${window.location.origin}/explore/recommend?facilityId=${encodeURIComponent(facilityId)}&lat=${lat}&lng=${lng}&ref=share`
                            : undefined
                        }
                        className="w-full justify-center"
                      />
                    </div>
                  </div>
                  </div>
                </div>
              );
            })}
            </>
          ) : loadFailed ? (
            // 실패는 '없음' 이 아니다 — 다시 시도할 길을 준다.
            <ErrorState message={t("recommend.loadFailed")} onRetry={() => window.location.reload()} />
          ) : (
            <div className="bg-white p-8 rounded-2xl border border-line toss-surface text-center text-sm text-muk-soft">
              {t("recommend.noAlternatives", { km: MAX_RECO_DISTANCE_M / 1000 })}
            </div>
          )}
        </section>

        {/* 3. Refresh Action Button */}
        {recommendations.length > 0 && (
          <div className="pt-2">
            <button
              type="button"
              onClick={handleRejectAllAndRefresh}
              disabled={isRefreshing}
              className="toss-pressable min-h-11 w-full py-3 bg-white hover:bg-hanji-deep border border-line rounded-xl text-muk-soft hover:text-muk font-semibold text-xs transition-colors flex items-center justify-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 disabled:opacity-50 toss-surface"
            >
              {isRefreshing ? (
                <>
                  <span className="w-3.5 h-3.5 border-2 border-muk-soft border-t-transparent rounded-full animate-spin" />
                  {t("recommend.loadingMore")}
                </>
              ) : (
                <>
                  🔄 {t("recommend.seeOther")}
                </>
              )}
            </button>
          </div>
        )}
      </div>

      {/* ── 음성 비서 오버레이 (음성 컨시어지) ── */}
      {!loadingRecommendations && recommendations.length > 0 && ttsSupported && !showOnboarding && (
        <div
          className="fixed right-4 z-40 flex flex-col items-end gap-2 select-none"
          style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 1.25rem)" }}
        >
          {/* 자막 / 안내 pill (스크린리더 라이브 영역) */}
          {assistantActive && (
            <div
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className="max-w-[15rem] md:max-w-[17rem] border border-line rounded-2xl px-3.5 py-2.5 toss-surface bg-white/90 backdrop-blur"
            >
              <div className="flex items-center gap-1.5 mb-1">
                {/* 단청 오방색 점 */}
                <span className="flex gap-0.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-gold" />
                  <span className="w-1.5 h-1.5 rounded-full bg-terracotta" />
                  <span className="w-1.5 h-1.5 rounded-full bg-jade" />
                  <span className="w-1.5 h-1.5 rounded-full bg-dan-red" />
                </span>
                <span className="text-[10px] font-bold tracking-wide gradient-text">{t("recommend.assistantName")}</span>
              </div>
              <p className="text-[11px] leading-snug text-muk min-h-[1.1rem]">
                {voiceState === "listening"
                  ? liveTranscript
                    ? `“${liveTranscript}”`
                    : t("recommend.listening")
                  : voiceState === "thinking"
                  ? t("recommend.interpreting")
                  : voiceState === "speaking"
                  ? spokenCaption || t("recommend.speakingDefault")
                  : t("recommend.canRespondByVoice")}
              </p>
              <p className="text-[10px] text-muk-soft mt-1">{t("recommend.voiceHint")}</p>
              {!sttSupported && (
                <p className="text-[10px] text-gold-deep mt-1">{t("recommend.sttUnsupportedHint")}</p>
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            {assistantActive && (
              <button
                type="button"
                onClick={toggleAssistantMute}
                aria-label={assistantMuted ? t("recommend.unmuteAria") : t("recommend.muteAria")}
                className="toss-pressable w-11 h-11 rounded-full flex items-center justify-center border border-line bg-white text-muk-soft hover:text-muk text-sm shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
              >
                {assistantMuted ? "🔇" : "🔈"}
              </button>
            )}
            <button
              type="button"
              onClick={onOrbClick}
              aria-label={assistantActive ? t("recommend.stopAria") : t("recommend.listenCta")}
              className={`relative w-14 h-14 overflow-hidden rounded-full flex items-center justify-center text-xl shadow-sm transition-all active:scale-95 border focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 ${
                voiceState === "listening"
                  ? "bg-jade/15 border-jade/60"
                  : voiceState === "speaking"
                  ? "bg-gold/15 border-gold/60"
                  : voiceState === "thinking"
                  ? "bg-terracotta/15 border-terracotta/60"
                  : "bg-gradient-to-br from-gold/25 to-terracotta/25 border-line"
              }`}
            >
              {!assistantActive && (
                <span className="absolute inset-0 rounded-full border border-gold/40 animate-ping" />
              )}
              {!assistantActive ? (
                <span>🔊</span>
              ) : voiceState === "speaking" ? (
                <span className="flex items-end gap-0.5 h-5">
                  {[0, 1, 2, 3].map((i) => (
                    <span
                      key={i}
                      className="w-1 bg-gold-deep rounded-full animate-pulse"
                      style={{ height: `${8 + (i % 2) * 8}px`, animationDelay: `${i * 120}ms` }}
                    />
                  ))}
                </span>
              ) : voiceState === "listening" ? (
                <span className="relative flex items-center justify-center">
                  <span className="absolute w-9 h-9 rounded-full bg-jade/25 animate-ping" />
                  <span className="flex gap-1">
                    {[0, 1, 2].map((i) => (
                      <span
                        key={i}
                        className="w-1.5 h-1.5 rounded-full bg-jade animate-bounce"
                        style={{ animationDelay: `${i * 150}ms` }}
                      />
                    ))}
                  </span>
                </span>
              ) : voiceState === "thinking" ? (
                <span className="w-5 h-5 border-2 border-terracotta border-t-transparent rounded-full animate-spin" />
              ) : (
                <span>🔊</span>
              )}
            </button>
          </div>

          {!assistantActive && (
            <span className="text-[10px] text-muk bg-white/90 border border-line rounded-full px-2.5 py-1 animate-pulse shadow-sm">
              🔊 {t("recommend.listenCta")}
            </span>
          )}
        </div>
      )}

      {/* Onboarding Overlay Modal (Cold Start) */}
      {showOnboarding && (
        <div className="fixed inset-0 z-50 bg-muk/40 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-white max-w-sm w-full p-6 md:p-8 rounded-3xl border border-line space-y-6 shadow-2xl relative">
            <div className="absolute top-0 right-0 w-32 h-32 bg-gold/10 rounded-full blur-3xl pointer-events-none" />
            <div className="space-y-2 text-center">
              <span className="text-xl">🎯</span>
              <h3 className="text-lg font-serif font-extrabold text-muk">{t("recommend.onboardingTitle")}</h3>
              <p className="text-xs text-muk-soft leading-relaxed">
                {t("recommend.onboardingBody")}
              </p>
            </div>

            {/* 자연어 선호 입력 (텍스트 + 음성) */}
            <div className="space-y-2">
              <label className="text-[11px] font-bold text-gold-deep flex items-center gap-1.5">
                🎙️ {t("recommend.nlLabel")}
              </label>
              <div className="relative">
                <textarea
                  value={nlText}
                  onChange={(e) => setNlText(e.target.value)}
                  rows={2}
                  placeholder={t("recommend.nlPlaceholder")}
                  className="w-full bg-hanji-deep border border-line rounded-2xl p-3 pr-14 text-xs text-muk placeholder:text-muk-soft outline-none focus:border-gold/60 resize-none"
                />
                <button
                  type="button"
                  onClick={isListening ? stopVoice : startVoice}
                  title={t("recommend.speakByVoice")}
                  className={`toss-pressable absolute right-2 top-2 w-10 h-10 rounded-full flex items-center justify-center border focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 ${
                    isListening
                      ? "bg-terracotta/20 border-terracotta text-terracotta animate-pulse"
                      : "bg-white border-line text-muk-soft hover:text-muk hover:border-gold/40"
                  }`}
                >
                  {isListening ? "■" : "🎤"}
                </button>
              </div>
              <button
                type="button"
                onClick={handleNlAnalyze}
                disabled={isParsingNl || !nlText.trim()}
                className="toss-pressable min-h-11 w-full flex items-center justify-center py-2.5 bg-gold/15 border border-gold/30 text-gold-deep rounded-xl font-bold text-xs hover:bg-gold/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 disabled:opacity-40"
              >
                {isParsingNl ? t("recommend.nlAnalyzing") : t("recommend.nlAnalyzeCta")}
              </button>
              {nlSummary && (
                <p className="text-[11px] leading-snug text-muk bg-jade/10 border border-jade/20 rounded-xl px-3 py-2">
                  💡 {nlSummary}
                </p>
              )}
              {nlApplied && (
                <button
                  type="button"
                  onClick={handleApplyNlAndFetch}
                  className="toss-pressable min-h-11 w-full flex items-center justify-center py-2.5 bg-gradient-to-r from-jade to-gold text-white rounded-xl font-bold text-xs transition-opacity hover:opacity-90 shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
                >
                  {t("recommend.nlGetRecs")} →
                </button>
              )}
            </div>

            {/* 구분선 */}
            <div className="flex items-center gap-3 text-[10px] text-muk-soft">
              <div className="flex-1 h-px bg-line" />
              {t("recommend.orSelectManually")}
              <div className="flex-1 h-px bg-line" />
            </div>

            {/* Checkbox Grid */}
            <div className="grid grid-cols-2 gap-2">
              {categoriesList.map((cat) => {
                const isSelected = selectedOnboardingCats.includes(cat.id);
                return (
                  <button
                    key={cat.id}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => {
                      if (isSelected) {
                        setSelectedOnboardingCats(selectedOnboardingCats.filter((id) => id !== cat.id));
                      } else {
                        setSelectedOnboardingCats([...selectedOnboardingCats, cat.id]);
                      }
                    }}
                    className={`toss-pressable min-h-11 p-3 rounded-2xl border text-xs font-semibold text-center focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 ${
                      isSelected
                        ? "bg-gold/15 border-gold text-muk shadow-sm"
                        : "bg-hanji-deep border-line text-muk-soft hover:border-gold/40 hover:text-muk"
                    }`}
                  >
                    {t(cat.labelKey)} {cat.emoji}
                  </button>
                );
              })}
            </div>

            {/* Submit onboarding Button */}
            <button
              type="button"
              onClick={handleOnboardingSubmit}
              disabled={selectedOnboardingCats.length < 3 || isOnboardingSubmitting}
              className="toss-pressable min-h-11 w-full flex items-center justify-center py-3 bg-gradient-to-r from-gold to-terracotta text-white rounded-xl font-bold text-xs transition-opacity duration-300 hover:opacity-90 shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 disabled:opacity-50"
            >
              {isOnboardingSubmitting ? t("recommend.savingSettings") : t("recommend.selectDone", { n: selectedOnboardingCats.length })}
            </button>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      
    </main>
  );
}

// Suspense fallback — useT 로 로케일 반영(정적 export: 최초 렌더는 ko 기본 후 스왑).
function RecommendFallback() {
  const t = useT();
  return (
    <div className="min-h-screen bg-hanji text-muk flex items-center justify-center">
      <div className="text-muk-soft text-sm animate-pulse">{t("recommend.preparing")}</div>
    </div>
  );
}

// Suspense wrapped Page Export
export default function RecommendPage() {
  return (
    <Suspense fallback={<RecommendFallback />}>
      <RecommendContent />
    </Suspense>
  );
}
