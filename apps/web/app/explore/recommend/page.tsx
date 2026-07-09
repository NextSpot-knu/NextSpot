"use client";

import React, { useState, useEffect, useRef, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { createPublicClient } from "@/lib/supabase";
const supabase = createPublicClient();
import { getRecommendations, submitFeedback, parsePreference, RecommendationResponse } from "@/lib/api-client";
import { MAX_RECO_DISTANCE_M } from "@/lib/recommender"; // 빈 상태 문구의 반경(1.5km) — 하드코딩 대신 실제 컷오프 상수 사용
import { classifyIntent, buildCardSpeech } from "@/lib/voiceIntent";
import { REGION, isWithinRegion } from "@/lib/region";
import { toast } from "sonner";

// Extend global Window
declare global {
  interface Window {
    kakao: any;
  }
}

// 데모 회복탄력성: 백엔드/Gemini 사유가 없을 때(목업·폴백)도 추천 사유가 비지 않도록
// 보여줄 결정적 한국어 사유를 생성한다. 백엔드 reason_service._build_template 와 어투를 맞춰 일관성 유지.
function buildMockReason(name: string, waitMin: number, distanceM: number, congestionLevel: number = 0): string {
  const walk = Math.max(1, Math.round(distanceM / 66.67)); // 66.67m/min = 4km/h (백엔드 WALKING_SPEED_M_PER_MIN 와 일치)
  // 혼잡(>=0.75)이면 추천하지 않고 혼잡·대기를 솔직히 알린다.
  if (congestionLevel >= 0.75) {
    return `${name}: 도보 ${walk}분 거리지만 지금은 혼잡도 ${Math.round(congestionLevel * 100)}%로 붐벼 대기가 길 수 있어요.`;
  }
  const mood = congestionLevel >= 0.5 ? "대기가 길지 않은 편이에요" : "지금 비교적 여유로워요";
  return `${name} 추천: 도보 ${walk}분, 예상 대기 ${Math.round(waitMin)}분 수준으로 ${mood}.`;
}

// MiniMap Component for Kakao Maps inside alternative cards
interface MiniMapProps {
  latitude: number;
  longitude: number;
  mapLoaded: boolean;
}

const MiniMap = React.memo(({ latitude, longitude, mapLoaded }: MiniMapProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
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
          <div className="text-[11px] font-semibold text-muk">경주 관광지</div>
          <div className="text-[9px] text-muk-soft mt-0.5">위치 미리보기</div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="w-full h-24 md:h-28 rounded-xl overflow-hidden border border-line"
    />
  );
});
MiniMap.displayName = "MiniMap";

// Original Facility Interface
interface OriginalFacility {
  id: string;
  name: string;
  type: string;
  congestionLevel: number;
  features: Record<string, any>;
}



// The core content wrapper component that handles Search Params
function RecommendContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  // Query Params
  const facilityId = searchParams.get("facilityId") || "";
  const paramLat = searchParams.get("lat");
  const paramLng = searchParams.get("lng");

  // State
  const [userId, setUserId] = useState<string | null>(null);
  const [originalFacility, setOriginalFacility] = useState<OriginalFacility | null>(null);
  const [originalWaitTime, setOriginalWaitTime] = useState<string>("--");
  const [recommendations, setRecommendations] = useState<RecommendationResponse[]>([]);
  
  const [loadingOriginal, setLoadingOriginal] = useState(true);
  const [loadingRecommendations, setLoadingRecommendations] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [mapLoaded, setMapLoaded] = useState(false);

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
  const recognitionRef = useRef<any>(null);
  // 빠른 더블클릭으로 인한 중복 피드백 전송 방지 — 리렌더 전에도 동기적으로 차단되는 가드
  const votedRef = useRef<Set<string>>(new Set());


  // 추천별 만족도 피드백(👍/👎) 기록 — 중복 전송 방지 + 버튼 선택 상태 표시
  const [feedbackVotes, setFeedbackVotes] = useState<Record<string, "up" | "down">>({});

  // Coordinates used for recommendations
  const [lat, setLat] = useState<number>(REGION.center.lat);
  const [lng, setLng] = useState<number>(REGION.center.lng);

  // ── 음성 비서(Hey Gemini 컨시어지) 상태 ──
  // Gemini가 만든 추천 사유를 한국어 TTS로 읽어주고(speechSynthesis), 사용자의 음성 응답을
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

  const assistantRecRef = useRef<any>(null);
  const voiceUnlockedRef = useRef(false);
  const listenTimeoutRef = useRef<any>(null);
  const speakFollowupRef = useRef<any>(null); // 발화 후 STT 시작 예약 타이머(정리 추적)
  const voicesRef = useRef<any[]>([]);
  const voiceStateRef = useRef<"idle" | "speaking" | "listening" | "thinking">("idle");
  const activeRecIndexRef = useRef(0);
  const mutedRef = useRef(false);
  const recommendationsRef = useRef<RecommendationResponse[]>([]);
  // 원시설 type 을 ref 로도 보관 — Effect2 deps 에서 originalFacility 객체를 빼도(이중 fetch 경합 제거)
  // 폴백 카테고리를 stale 클로저 없이 최신값으로 읽기 위함.
  const originalFacilityTypeRef = useRef<string | null>(null);
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
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
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
    // 새 추천 세트엔 이전 세트의 만족도 상태가 무의미하다. 목업은 고정 id(mock-rec-id-N)를 재사용하므로
    // 초기화하지 않으면 '다른 대안 보기'·NL 재요청으로 같은 id 가 다시 와 새 카드의 👍/👎 가 잠긴다.
    votedRef.current = new Set();
    setFeedbackVotes({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recommendations]);

  // 온보딩 모달이 열리면 음성 비서 정지, 닫히면 온보딩 음성입력(recognitionRef)도 정지(이중 인식 충돌 방지).
  useEffect(() => {
    if (showOnboarding) {
      quietAssistant();
    } else {
      try { recognitionRef.current?.stop?.(); } catch { /* noop */ }
      setIsListening(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showOnboarding]);

  // 탭이 숨겨지면(백그라운드) 발화/인식 정지 — 일부 브라우저의 발화 큐잉/정지 이슈 회피.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => { if (document.hidden) quietAssistant(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        setUserId(session.user.id);
      } else {
        console.warn("No active session found, falling back to mock visitor GYEONGJU-VISITOR-01.");
        setUserId("a2222222-2222-2222-2222-222222222222"); // Fallback mock visitor ID
      }
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
        }
      );
    }
  }, [paramLat, paramLng]);

  // Fallback Mock Seed Data for Resilient Local Demos (경주 황리단길)
  // 실데이터 전용: 목업 시드 제거. FastAPI 추천 미가용 시 빈 추천(에러/빈 상태)으로 처리한다.
  const MOCK_SEED_FACILITIES: any[] = [];

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
              timestamp
            )
          `)
          .eq("id", facilityId)
          .order("timestamp", { foreignTable: "congestion_logs", ascending: false })
          .limit(1, { foreignTable: "congestion_logs" })
          .single();

        let originalData = data;
        if (error || !data) {
          console.warn("Using fallback local details for original facility.");
          originalData = MOCK_SEED_FACILITIES.find((f) => f.id === facilityId) || null;
        }

        if (originalData) {
          const latestLog = originalData.congestion_logs && originalData.congestion_logs[0];
          const level = latestLog ? latestLog.congestion_level : 0.0;

          setOriginalFacility({
            id: originalData.id,
            name: originalData.name,
            type: originalData.type,
            congestionLevel: level,
            features: originalData.features || {},
          });
          originalFacilityTypeRef.current = originalData.type;

          const defaultTimes: Record<string, number> = {
            restaurant: 25,
            cafe: 12,
            attraction: 15,
            culture: 15,
          };
          const avgProcessTime = originalData.features?.average_processing_time ?? defaultTimes[originalData.type] ?? 15;
          const hour = new Date().getHours();
          let timeMultiplier = 1.0;
          if (hour >= 11 && hour < 14) timeMultiplier = 1.3;
          else if (hour >= 14 && hour < 18) timeMultiplier = 1.2;

          const predicted = level * avgProcessTime * timeMultiplier;
          setOriginalWaitTime(predicted.toFixed(1));
        }
      } catch (err) {
        console.warn("Failed to fetch original facility, falling back:", err);
        const fallbackObj = MOCK_SEED_FACILITIES.find((f) => f.id === facilityId);
        if (fallbackObj) {
          setOriginalFacility({
            id: fallbackObj.id,
            name: fallbackObj.name,
            type: fallbackObj.type,
            congestionLevel: fallbackObj.congestion_logs[0].congestion_level,
            features: fallbackObj.features,
          });
          originalFacilityTypeRef.current = fallbackObj.type;
          setOriginalWaitTime("17.5");
        }
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

        const recommendationsList = await getRecommendations(facilityId, { lat, lng });
        if (cancelled) return;
        setRecommendations(recommendationsList);
      } catch (err) {
        if (cancelled) return;
        console.warn("Error calling FastAPI, using demo fallback recommendations:", err);

        // Demo Fallback Recommendations — 원시설 type 은 deps 에서 originalFacility 객체를 뺀 대신 ref 로 읽는다.
        const filteredMock = MOCK_SEED_FACILITIES
          .filter(f => f.id !== facilityId && f.type === (originalFacilityTypeRef.current || "restaurant"));

        const fallbacks: RecommendationResponse[] = filteredMock
          .slice(0, 5)
          .map((f, i) => ({
            recommendationId: `mock-rec-id-${i}`,
            facility: {
              id: f.id,
              name: f.name,
              type: f.type,
              latitude: f.latitude,
              longitude: f.longitude,
              capacity: f.capacity,
              operatingHours: f.operating_hours,
              features: f.features
            },
            spotScore: 85 - (i * 10),
            breakdown: {
              preference: 0.9 - (i * 0.15),
              waitTime: 5 + (i * 3),
              travelTime: 2.5 + i,
              incentive: 0.2
            },
            distanceM: 120 + (i * 35),
            reason: buildMockReason(f.name, 5 + (i * 3), 120 + (i * 35), f.congestion_logs?.[0]?.congestion_level ?? 0),
            rank: i + 1,
            totalCandidates: filteredMock.length
          }));

        setRecommendations(fallbacks);
      } finally {
        if (!cancelled) setLoadingRecommendations(false);
      }
    }

    checkHistoryAndFetch();
    return () => { cancelled = true; };
    // originalFacility 를 deps 에서 제거: 매번 새 객체로 세팅돼 추천을 이중 fetch 시키던 경합의 원인이었다.
    // 폴백 카테고리는 originalFacilityTypeRef 로 최신값을 읽는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, facilityId, lat, lng]);

  // 추천 API 실패 시 데모용 목업 추천 생성 (회복탄력성)
  const buildMockRecommendations = (): RecommendationResponse[] => {
    const filteredMock = MOCK_SEED_FACILITIES
      .filter((f) => f.id !== facilityId && f.type === (originalFacility?.type || "restaurant"));
    return filteredMock.slice(0, 5).map((f, i) => ({
      recommendationId: `mock-rec-id-${i}`,
      facility: {
        id: f.id,
        name: f.name,
        type: f.type,
        latitude: f.latitude,
        longitude: f.longitude,
        capacity: f.capacity,
        operatingHours: f.operating_hours,
        features: f.features,
      },
      spotScore: 85 - i * 10,
      breakdown: { preference: 0.9 - i * 0.15, waitTime: 5 + i * 3, travelTime: 2.5 + i, incentive: 0.2 },
      distanceM: 120 + i * 35,
      reason: buildMockReason(f.name, 5 + i * 3, 120 + i * 35, f.congestion_logs?.[0]?.congestion_level ?? 0),
      rank: i + 1,
      totalCandidates: filteredMock.length,
    }));
  };

  // 음성 입력 시작 (Web Speech API). 미지원 브라우저는 텍스트 입력으로 폴백.
  const startVoice = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      toast.error("이 브라우저는 음성 인식을 지원하지 않아요. 텍스트로 입력해 주세요.");
      return;
    }
    try {
      const rec = new SR();
      rec.lang = "ko-KR";
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      rec.onresult = (e: any) => {
        const transcript = e.results?.[0]?.[0]?.transcript ?? "";
        if (transcript) setNlText((prev) => (prev ? prev + " " : "") + transcript);
      };
      rec.onend = () => setIsListening(false);
      rec.onerror = () => {
        setIsListening(false);
        toast.error("음성 인식에 실패했어요. 텍스트로 입력해 주세요.");
      };
      recognitionRef.current = rec;
      setIsListening(true);
      rec.start();
    } catch {
      setIsListening(false);
      toast.error("음성 인식을 시작할 수 없어요.");
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

  // 자연어 → Gemini 파싱 → 선호 벡터/카테고리 반영 (서버가 저장까지 수행)
  const handleNlAnalyze = async () => {
    if (!nlText.trim()) {
      toast.info("선호하는 시설이나 분위기를 말하거나 적어주세요.");
      return;
    }
    setIsParsingNl(true);
    try {
      const result = await parsePreference(nlText.trim());
      setNlSummary(result.summary);
      if (result.preferredCategories?.length) {
        setSelectedOnboardingCats(result.preferredCategories);
      }
      setNlApplied(true);
      toast.success(result.isFallback ? "선호를 반영했어요 (키워드 분석)" : "AI가 선호를 반영했어요 🎯");
    } catch (err) {
      // 서버(Gemini) 연결 실패 시 클라이언트 키워드 폴백 — 데모가 끊기지 않게.
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
        setNlSummary("AI 서버에 연결하지 못해 키워드로 분석했어요. 아래에서 조정할 수 있어요.");
        setNlApplied(true);
        toast.success("키워드로 선호를 반영했어요");
      } else {
        toast.error("AI 분석에 실패했어요. 아래에서 직접 선택해 주세요.");
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
      const list = await getRecommendations(facilityId, { lat, lng });
      setRecommendations(list);
    } catch (err) {
      console.warn("Fetch after NL preference failed, using mock fallback:", err);
      setRecommendations(buildMockRecommendations());
    } finally {
      setLoadingRecommendations(false);
    }
  };

  // Handle Onboarding Preferences Submission
  const handleOnboardingSubmit = async () => {
    if (selectedOnboardingCats.length < 3) {
      toast.info("선호하는 장소 종류를 3개 이상 선택해 주세요!");
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
      toast.success("선호 정보가 등록되었습니다! 맞춤 추천을 계산합니다.");

      // 2. Fetch recommendations (FastAPI will detect missing Pinecone vector,
      // load the updated DB categories, generate the average vector, upsert, and query).
      setLoadingRecommendations(true);
      const recommendationsList = await getRecommendations(facilityId, { lat, lng });
      setRecommendations(recommendationsList);
    } catch (err) {
      console.warn("Error during onboarding fetch fallback:", err);
      // Fallback: If FastAPI recommend API fails, load mock recommendations
      const filteredMock = MOCK_SEED_FACILITIES
        .filter(f => f.id !== facilityId && f.type === (originalFacility?.type || "restaurant"));
      
      const fallbacks: RecommendationResponse[] = filteredMock
        .slice(0, 5)
        .map((f, i) => ({
          recommendationId: `mock-rec-id-${i}`,
          facility: {
            id: f.id,
            name: f.name,
            type: f.type,
            latitude: f.latitude,
            longitude: f.longitude,
            capacity: f.capacity,
            operatingHours: f.operating_hours,
            features: f.features
          },
          spotScore: 85 - (i * 10),
          breakdown: {
            preference: 0.9 - (i * 0.15),
            waitTime: 5 + (i * 3),
            travelTime: 2.5 + i,
            incentive: 0.2
          },
          distanceM: 120 + (i * 35),
          reason: buildMockReason(f.name, 5 + (i * 3), 120 + (i * 35), f.congestion_logs?.[0]?.congestion_level ?? 0),
          rank: i + 1,
          totalCandidates: filteredMock.length
        }));
      setRecommendations(fallbacks);
      setShowOnboarding(false);
    } finally {
      setIsOnboardingSubmitting(false);
      setLoadingRecommendations(false);
    }
  };

  // CTA Click: Accept Alternative
  const handleAccept = async (rec: RecommendationResponse) => {
    quietAssistant(); // 음성 비서 진행 중이면 정리(수동/음성 수락 공통)
    // 팝업 차단 방지: 동기적 흐름 내에서 빈 창을 즉시 오픈
    const newWindow = window.open("about:blank", "_blank");
    
    try {
      toast.success("선택 경로 수락 완료! 안내를 시작합니다.");
      
      // 1. Submit feedback accepted to FastAPI
      await submitFeedback(rec.recommendationId, "accepted");

      // 2. Prepare toast category-specific greeting
      let greeting = "즐거운 시간 되세요!";
      if (rec.facility.type === "restaurant") greeting = "맛있게 드세요!";
      else if (rec.facility.type === "cafe") greeting = "여유로운 시간 되세요!";
      else if (rec.facility.type === "attraction" || rec.facility.type === "culture") greeting = "즐거운 관람 되세요!";

      toast.success(`${greeting} 다음 추천이 더 정확해집니다 🎯`);

      // 3. Open Kakao Maps Directions (Hybrid approach)
      const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
      
      if (isMobile) {
        const destUrl = `kakaomap://route?sp=${lat},${lng}&ep=${rec.facility.latitude},${rec.facility.longitude}&by=CAR`;
        if (newWindow) newWindow.location.href = destUrl;
        else window.location.href = destUrl;
      } else {
        // 키는 env 전용 — 하드코딩 폴백 금지(커밋된 키는 유출로 간주, 로테이션 대상).
        const restApiKey = process.env.NEXT_PUBLIC_KAKAO_REST_API_KEY;
        if (!restApiKey) {
          // 키 미설정: 좌표 변환(transcoord) 없이 텍스트 채우기 방식 길찾기로 폴백(아래 catch 와 동일 경로).
          const destUrl = `https://map.kakao.com/?sName=${encodeURIComponent("현재 위치")}&eName=${encodeURIComponent(rec.facility.name)}&sY=${lat}&sX=${lng}&eY=${rec.facility.latitude}&eX=${rec.facility.longitude}`;
          if (newWindow) newWindow.location.href = destUrl;
          else window.location.href = destUrl;
          return;
        }
        const headers = { 'Authorization': `KakaoAK ${restApiKey}` };

        const urlStart = `https://dapi.kakao.com/v2/local/geo/transcoord.json?x=${lng}&y=${lat}&input_coord=WGS84&output_coord=WCONGNAMUL`;
        const urlEnd = `https://dapi.kakao.com/v2/local/geo/transcoord.json?x=${rec.facility.longitude}&y=${rec.facility.latitude}&input_coord=WGS84&output_coord=WCONGNAMUL`;

        Promise.all([
          fetch(urlStart, { headers }).then(r => r.json()),
          fetch(urlEnd, { headers }).then(r => r.json())
        ]).then(([startData, endData]) => {
          if (startData.documents?.length > 0 && endData.documents?.length > 0) {
            const sX = startData.documents[0].x;
            const sY = startData.documents[0].y;
            const eX = endData.documents[0].x;
            const eY = endData.documents[0].y;
            const destUrl = `https://map.kakao.com/?map_type=TYPE_MAP&target=car&rt=${sX},${sY},${eX},${eY}&rt1=${encodeURIComponent("현재 위치")}&rt2=${encodeURIComponent(rec.facility.name)}`;
            if (newWindow) newWindow.location.href = destUrl;
            else window.location.href = destUrl;
          } else {
            throw new Error("좌표 변환 실패");
          }
        }).catch(err => {
          console.warn("PC 길안내 자동 시작 실패:", err);
          const destUrl = `https://map.kakao.com/?sName=${encodeURIComponent("현재 위치")}&eName=${encodeURIComponent(rec.facility.name)}&sY=${lat}&sX=${lng}&eY=${rec.facility.latitude}&eX=${rec.facility.longitude}`;
          if (newWindow) newWindow.location.href = destUrl;
          else window.location.href = destUrl;
        });
      }
    } catch (err) {
      console.warn("Error submitting accepted feedback:", err);
      // 에러 발생 시에도 빈 창이 덩그러니 남지 않도록 목적지로 보냄
      const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
      const destUrl = isMobile 
        ? `kakaomap://route?sp=${lat},${lng}&ep=${rec.facility.latitude},${rec.facility.longitude}&by=CAR`
        : `https://map.kakao.com/?sName=${encodeURIComponent("현재 위치")}&eName=${encodeURIComponent(rec.facility.name)}&sY=${lat}&sX=${lng}&eY=${rec.facility.latitude}&eX=${rec.facility.longitude}`;
      
      if (newWindow) {
        newWindow.location.href = destUrl;
      } else {
        window.location.href = destUrl;
      }
    }
  };

  // 추천 카드별 만족도 피드백(👍/👎). 백엔드 액션에 매핑: 👍=accepted(선호벡터 +10%), 👎=rejected(-5%).
  // 만족도 신호일 뿐 실제 경로 이동('여기로 갈래요')과는 별개다. 목업 추천(mock- 접두)은 DB 기록이 없어
  // 서버 호출을 건너뛰고 UI 상태/토스트만 갱신해 데모가 끊기지 않게 한다.
  const handleSatisfactionFeedback = async (rec: RecommendationResponse, vote: "up" | "down") => {
    // 동기 가드(ref): 상태 반영(리렌더) 전 빠른 연타도 차단. feedbackVotes 가드/버튼 숨김은 보조.
    if (votedRef.current.has(rec.recommendationId) || feedbackVotes[rec.recommendationId]) return;
    votedRef.current.add(rec.recommendationId);
    setFeedbackVotes((prev) => ({ ...prev, [rec.recommendationId]: vote }));
    toast.success(
      vote === "up"
        ? "좋아요! 이런 추천을 더 보여드릴게요 🎯"
        : "알려줘서 고마워요. 다음 추천에 반영할게요 🙏"
    );
    if (rec.recommendationId.startsWith("mock-")) return; // 데모 폴백 추천은 서버에 기록 없음
    try {
      await submitFeedback(rec.recommendationId, vote === "up" ? "accepted" : "rejected");
    } catch (err) {
      console.warn("만족도 피드백 전송 실패(데모 동작에는 영향 없음):", err);
    }
  };

  // "다른 대안 보기" Click: Reject current top 3, fetch next 3
  const handleRejectAllAndRefresh = async () => {
    if (recommendations.length === 0 || !facilityId) return;
    quietAssistant(); // 음성 비서 진행 중이면 정리(수동/음성 새로고침 공통)
    setIsRefreshing(true);
    try {
      // 1. 실제 추천만 rejected 전송 — 목업(mock-rec-id)은 DB 기록이 없어 404 이므로 스킵하고,
      //    개별 실패도 allSettled 로 삼켜 한 건 실패가 전체를 깨뜨리지 않게 한다(handleSatisfactionFeedback 과 대칭).
      await Promise.allSettled(
        recommendations
          .filter((rec) => !rec.recommendationId.startsWith("mock-"))
          .map((rec) => submitFeedback(rec.recommendationId, "rejected"))
      );

      // 2. 새 추천 시도, 실패 시 목업 폴백(데모 무중단). 기존엔 폴백이 없어 데모 경로에서 항상 에러 토스트만 떴다.
      try {
        const fresh = await getRecommendations(facilityId, { lat, lng });
        setRecommendations(fresh);
      } catch (e) {
        console.warn("refresh fetch failed, mock fallback:", e);
        setRecommendations(buildMockRecommendations());
      }
      toast.success("선호도를 조정하여 새로운 대안을 추천했습니다 🔍");
    } catch (err) {
      console.warn("Error during rejecting and refreshing:", err);
      toast.error("새 추천 대안을 불러오는 도중 오류가 발생했습니다.");
    } finally {
      setIsRefreshing(false);
    }
  };

  // ───────────────────────── 음성 비서 헬퍼 ─────────────────────────
  // (forward 참조는 모두 이벤트/타이머에서 실행되므로 런타임에 안전 — 컴포넌트 본문이 끝난 뒤 호출됨)
  const pickKoVoice = () => {
    const vs = voicesRef.current || [];
    return (
      vs.find((v: any) => v.lang === "ko-KR") ||
      vs.find((v: any) => (v.lang || "").toLowerCase().startsWith("ko")) ||
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
      finishAssistant("추천을 모두 안내했어요. 마음에 드는 곳을 선택해 주세요.");
    }
  };

  const handleNoResponse = () => {
    if (voiceStateRef.current === "idle") return;
    if (repromptCountRef.current < 1) {
      repromptCountRef.current += 1;
      const msg = "수락하려면 '응', 넘기려면 '다음'이라고 말해 주세요.";
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
        finishAssistant("음성 안내를 마칠게요.");
        break;
      case "rejectAll":
        // 확인 멘트를 끝까지 들려준 뒤 새로고침(직후 호출하면 그 핸들러의 quietAssistant가 발화를 끊음).
        sayThen("새로운 대안을 찾아볼게요.", () => handleRejectAllAndRefresh());
        break;
      case "accept":
        // 확인 멘트를 끝까지 들려준 뒤 길안내(onEnd 시점엔 발화가 끝나 handleAccept의 cancel이 무해).
        sayThen("알겠어요, 여기로 안내할게요!", () => handleAccept(rec));
        break;
      case "detail": {
        const waitTime = rec.breakdown?.waitTime?.toFixed(1) || "--";
        const travelTime = (rec.distanceM / 80).toFixed(1);
        const preferencePct = Math.round((rec.breakdown?.preference || 0) * 100);
        sayThen(
          `예상 대기 ${waitTime}분, 도보 ${travelTime}분, 선호 일치율 ${preferencePct}%예요. 여기로 안내할까요?`,
          () => scheduleListen()
        );
        break;
      }
      case "negative":
        handleSatisfactionFeedback(rec, "down");
        sayThen("알려줘서 고마워요. 다음 추천 보여드릴게요.", () => advanceOrFinish(cardIndex));
        break;
      case "next":
        sayThen("다음 추천 보여드릴게요.", () => advanceOrFinish(cardIndex));
        break;
      default: // unknown
        handleNoResponse();
    }
  };

  const startAssistantListening = () => {
    if (typeof window === "undefined") return;
    if (voiceStateRef.current === "idle") return;
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
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
      rec.onresult = (e: any) => {
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
      rec.onerror = (e: any) => {
        startingRef.current = false;
        clearListenTimeout();
        const err = e?.error;
        if (err === "not-allowed" || err === "service-not-allowed") {
          setSttSupported(false);
          toast.info("마이크 권한이 없어 음성 응답은 끌게요. 카드 버튼으로 응답해 주세요.");
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
    const reasonText =
      rec.reason ||
      buildMockReason(rec.facility.name, rec.breakdown?.waitTime ?? 0, rec.distanceM);
    const sentence = buildCardSpeech(rec.facility.name, reasonText, index);
    setVoice("speaking");
    setSpokenCaption(sentence); // 발화 텍스트를 자막으로(청각 정보 시각 동시 제공 + Gemini 사유 가시화)
    speak(sentence, () => scheduleListen());
  };

  // 제스처 게이트: 오브/칩 onClick 콜백 동기 스택 안에서 첫 발화 → 자동재생 정책 통과.
  const startAssistant = () => {
    if (typeof window === "undefined") return;
    if (!("speechSynthesis" in window)) {
      toast.info("이 브라우저는 음성 안내를 지원하지 않아요.");
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
        return "음식점";
      case "cafe":
        return "카페";
      case "attraction":
        return "관광지";
      case "culture":
        return "문화시설";
      default:
        return "장소";
    }
  };

  const getCongestionLabel = (level: number) => {
    if (level >= 0.75) return "혼잡";
    if (level >= 0.5) return "보통";
    if (level >= 0.25) return "여유";
    return "한산";
  };

  const categoriesList = [
    { id: "restaurant", label: "음식점 🍴" },
    { id: "cafe", label: "카페 ☕" },
    { id: "attraction", label: "관광지 📸" },
    { id: "culture", label: "문화시설 🏛️" },
  ];

  return (
    <main className="min-h-screen bg-hanji text-muk p-4 md:p-8 flex flex-col justify-between items-center relative overflow-hidden">
      {/* 배경 은은한 노을·금빛 광원 (콜드 blue/purple 글로우 대체) */}
      <div className="absolute top-[-20%] left-[-10%] w-[600px] h-[600px] rounded-full bg-sunset-1/10 blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[600px] h-[600px] rounded-full bg-gold/10 blur-[120px] pointer-events-none" />

      <div className="w-full max-w-md md:max-w-2xl space-y-6 relative z-10 flex-1 py-4">
        {/* Header */}
        <header className="flex items-center justify-between border-b border-line pb-4">
          <button
            onClick={() => { quietAssistant(); router.push("/main"); }}
            className="text-xs text-muk-soft hover:text-muk flex items-center gap-1.5 transition-all duration-200"
          >
            ← 지도 보기
          </button>
          <span className="text-sm font-extrabold tracking-tight gradient-text">NextSpot 추천 AI</span>
          <div className="w-14"></div> {/* spacer */}
        </header>

        {/* 1. Original Facility Card */}
        <section>
          {loadingOriginal ? (
            <div className="bg-white p-5 rounded-2xl border border-line shadow-[0_2px_14px_rgba(43,35,32,0.06)] animate-pulse flex flex-col gap-3">
              <div className="h-4 bg-hanji-deep w-2/3 rounded-md" />
              <div className="h-3 bg-hanji-deep w-1/2 rounded-md" />
            </div>
          ) : originalFacility ? (
            <div className="bg-white p-5 rounded-2xl border border-terracotta/25 shadow-[0_2px_14px_rgba(43,35,32,0.06)] relative overflow-hidden">
              <div className="absolute top-0 right-0 w-24 h-24 bg-terracotta/10 rounded-full blur-2xl pointer-events-none" />
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-terracotta animate-pulse" />
                <span className="text-[10px] text-terracotta font-bold tracking-wider">우회 필요</span>
              </div>
              <h2 className="text-base md:text-lg font-serif font-bold text-muk mt-2">
                지금 <span className="text-terracotta">{originalFacility.name}</span>은{" "}
                <span className="text-terracotta">혼잡</span>합니다.
              </h2>
              <p className="text-xs text-muk-soft mt-1 leading-relaxed">
                현재 대기 시간은 약 <span className="font-semibold text-terracotta">{originalWaitTime}분</span>으로
                예상됩니다. 아래의 최적화된 SPOT 대안 시설을 권장합니다.
              </p>
            </div>
          ) : (
            <div className="bg-white p-5 rounded-2xl border border-line shadow-[0_2px_14px_rgba(43,35,32,0.06)] text-center text-xs text-muk-soft">
              시설 정보를 불러오지 못했습니다.
            </div>
          )}
        </section>

        {/* 2. Alternative Recommendation Cards List */}
        <section className="space-y-4">
          <h3 className="text-sm font-bold text-muk">실시간 추천 대안 (최대 3개)</h3>

          {loadingRecommendations ? (
            // Skeleton Loader
            [1, 2, 3].map((idx) => (
              <div key={idx} className="bg-white p-5 rounded-2xl border border-line shadow-[0_2px_14px_rgba(43,35,32,0.06)] animate-pulse flex flex-col gap-3">
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
            recommendations.map((rec, idx) => {
              const waitTime = rec.breakdown?.waitTime?.toFixed(1) || "--";
              const travelTime = (rec.breakdown?.travelTime ?? rec.distanceM / 66.67).toFixed(1); // 백엔드 SPOT travelTime 우선(66.67m/min=4km/h, 백엔드 일치), 없으면 거리환산
              const preferencePct = Math.round((rec.breakdown?.preference || 0) * 100);
              const isVoiceActive = assistantActive && idx === activeRecIndex; // 음성 비서가 지금 안내 중인 카드

              return (
                <div
                  key={rec.recommendationId}
                  className={`bg-white p-5 rounded-2xl border transition-all duration-300 shadow-[0_2px_14px_rgba(43,35,32,0.06)] ${
                    isVoiceActive
                      ? "border-gold ring-2 ring-gold/40 scale-[1.02]"
                      : "border-line hover:border-gold/40 hover:scale-[1.01]"
                  }`}
                >
                  {/* Top info row */}
                  <div className="flex justify-between items-start">
                    <div>
                      <span className="text-[10px] font-bold text-jade bg-jade/10 px-2 py-0.5 rounded-md">
                        {getTypeName(rec.facility.type)}
                      </span>
                      {rec.rank && rec.totalCandidates && (
                        <span className="text-[10px] font-bold text-gold-deep bg-gold/10 px-2 py-0.5 rounded-md ml-2">
                          대안 {rec.totalCandidates}개 중 {rec.rank}등
                        </span>
                      )}
                      {isVoiceActive && voiceState !== "idle" && (
                        <span className="text-[10px] font-bold text-jade bg-jade/10 px-2 py-0.5 rounded-md ml-2 inline-flex items-center gap-1 align-middle">
                          {voiceState === "speaking" ? "🔊 안내 중" : voiceState === "listening" ? "🎙️ 듣는 중" : "✨ 해석 중"}
                        </span>
                      )}
                      <h4 className="text-base font-extrabold text-muk mt-1.5">
                        {rec.facility.name}
                      </h4>
                    </div>
                    <div className="text-right">
                      <span className="text-[10px] text-muk-soft block">SPOT 지수</span>
                      <span className="text-sm font-extrabold text-gold-deep">
                        {Math.round(rec.spotScore <= 1.0 ? rec.spotScore * 100 : rec.spotScore)}점
                      </span>
                    </div>
                  </div>

                  {/* WP3: Gemini 생성 추천 사유 (있을 때만 노출) */}
                  {rec.reason && (
                    <p className="mt-2 text-[11px] leading-snug text-muk bg-gold/10 border border-gold/20 rounded-xl px-3 py-2">
                      💡 {rec.reason}
                    </p>
                  )}

                  {/* Minimap container */}
                  <div className="my-3">
                    <MiniMap
                      latitude={rec.facility.latitude}
                      longitude={rec.facility.longitude}
                      mapLoaded={mapLoaded}
                    />
                  </div>

                  {/* SPOT Breakdown Indicators */}
                  <div className="grid grid-cols-3 gap-2 py-2 border-t border-b border-line my-3 text-[11px] text-muk-soft">
                    <div className="text-center">
                      <span className="text-muk-soft block text-[9px]">선호 일치율</span>
                      <span className="font-bold text-jade">{preferencePct}%</span>
                    </div>
                    <div className="text-center border-l border-r border-line">
                      <span className="text-muk-soft block text-[9px]">예상 대기</span>
                      <span className="font-bold text-gold-deep">{waitTime}분</span>
                    </div>
                    <div className="text-center">
                      <span className="text-muk-soft block text-[9px]">예상 도보</span>
                      <span className="font-bold text-jade">{travelTime}분 ({Math.round(rec.distanceM)}m)</span>
                    </div>
                  </div>

                  {/* 만족도 피드백 (👍/👎) — 선호 벡터를 보정해 다음 추천에 반영 */}
                  <div className="flex items-center justify-between gap-2 mb-2.5">
                    <span className="text-[10px] text-muk-soft">이 추천이 도움이 됐나요?</span>
                    {feedbackVotes[rec.recommendationId] ? (
                      <span className="text-[10px] font-semibold text-jade">
                        {feedbackVotes[rec.recommendationId] === "up" ? "👍 반영했어요" : "👎 반영했어요"}
                      </span>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => handleSatisfactionFeedback(rec, "up")}
                          aria-label="이 추천이 도움이 됐어요"
                          className="px-2.5 py-1 rounded-lg text-[11px] font-semibold border bg-hanji-deep border-line text-muk-soft hover:border-jade/50 hover:text-jade transition-all active:scale-95"
                        >
                          👍 좋아요
                        </button>
                        <button
                          onClick={() => handleSatisfactionFeedback(rec, "down")}
                          aria-label="이 추천은 별로예요"
                          className="px-2.5 py-1 rounded-lg text-[11px] font-semibold border bg-hanji-deep border-line text-muk-soft hover:border-terracotta/50 hover:text-terracotta transition-all active:scale-95"
                        >
                          👎 별로예요
                        </button>
                      </div>
                    )}
                  </div>

                  {/* CTA button */}
                  <button
                    onClick={() => handleAccept(rec)}
                    className="w-full py-2.5 bg-gradient-to-r from-gold to-terracotta text-white rounded-xl font-bold text-xs transition-all duration-300 hover:opacity-90 active:scale-[0.98] shadow-sm"
                  >
                    여기로 갈래요
                  </button>
                </div>
              );
            })
          ) : (
            <div className="bg-white p-8 rounded-2xl border border-line shadow-[0_2px_14px_rgba(43,35,32,0.06)] text-center text-sm text-muk-soft">
              주변 {MAX_RECO_DISTANCE_M / 1000}km 이내에 추천 가능한 대안 시설이 없습니다.
            </div>
          )}
        </section>

        {/* 3. Refresh Action Button */}
        {recommendations.length > 0 && (
          <div className="pt-2">
            <button
              onClick={handleRejectAllAndRefresh}
              disabled={isRefreshing}
              className="w-full py-3 bg-white hover:bg-hanji-deep border border-line rounded-xl text-muk-soft hover:text-muk font-semibold text-xs transition-all duration-300 flex items-center justify-center gap-2 disabled:opacity-50 shadow-[0_2px_14px_rgba(43,35,32,0.06)]"
            >
              {isRefreshing ? (
                <>
                  <span className="w-3.5 h-3.5 border-2 border-muk-soft border-t-transparent rounded-full animate-spin" />
                  새로운 대안 로드 중...
                </>
              ) : (
                <>
                  🔄 다른 대안 보기
                </>
              )}
            </button>
          </div>
        )}
      </div>

      {/* ── 음성 비서 오버레이 (Hey Gemini 컨시어지) ── */}
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
              className="max-w-[15rem] md:max-w-[17rem] border border-line rounded-2xl px-3.5 py-2.5 shadow-[0_2px_14px_rgba(43,35,32,0.10)] bg-white/90 backdrop-blur"
            >
              <div className="flex items-center gap-1.5 mb-1">
                {/* 단청 오방색 점 */}
                <span className="flex gap-0.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-gold" />
                  <span className="w-1.5 h-1.5 rounded-full bg-terracotta" />
                  <span className="w-1.5 h-1.5 rounded-full bg-jade" />
                  <span className="w-1.5 h-1.5 rounded-full bg-dan-red" />
                </span>
                <span className="text-[10px] font-bold tracking-wide gradient-text">NextSpot 음성 비서</span>
              </div>
              <p className="text-[11px] leading-snug text-muk min-h-[1.1rem]">
                {voiceState === "listening"
                  ? liveTranscript
                    ? `“${liveTranscript}”`
                    : "듣고 있어요…"
                  : voiceState === "thinking"
                  ? "✨ 응답을 해석하고 있어요…"
                  : voiceState === "speaking"
                  ? spokenCaption || "추천을 안내하고 있어요. 끝나면 말씀해 주세요."
                  : "음성으로 응답할 수 있어요."}
              </p>
              <p className="text-[9px] text-muk-soft mt-1">응=수락 · 다음=넘기기 · 자세히 · 그만</p>
              {!sttSupported && (
                <p className="text-[9px] text-gold-deep mt-1">음성 응답 미지원 — 아래 카드 버튼으로 응답해 주세요</p>
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            {assistantActive && (
              <button
                onClick={toggleAssistantMute}
                aria-label={assistantMuted ? "음성 안내 켜기" : "음성 안내 끄기"}
                className="w-9 h-9 rounded-full flex items-center justify-center border border-line bg-white text-muk-soft hover:text-muk text-sm transition-all shadow-sm"
              >
                {assistantMuted ? "🔇" : "🔈"}
              </button>
            )}
            <button
              onClick={onOrbClick}
              aria-label={assistantActive ? "음성 안내 정지" : "AI 음성 추천 듣기"}
              className={`relative w-14 h-14 rounded-full flex items-center justify-center text-xl shadow-sm transition-all active:scale-95 border ${
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
              🔊 AI 음성 추천 듣기
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
              <h3 className="text-lg font-serif font-extrabold text-muk">맞춤형 추천 온보딩</h3>
              <p className="text-xs text-muk-soft leading-relaxed">
                NextSpot AI의 최적화된 SPOT 대안 경로 매칭을 위해, 관심 있는 장소 종류를 **3개 이상** 선택해 주세요.
              </p>
            </div>

            {/* 자연어 선호 입력 (텍스트 + 음성) */}
            <div className="space-y-2">
              <label className="text-[11px] font-bold text-gold-deep flex items-center gap-1.5">
                🎙️ 선호를 자연어로 말하거나 적어주세요 (AI가 분석)
              </label>
              <div className="relative">
                <textarea
                  value={nlText}
                  onChange={(e) => setNlText(e.target.value)}
                  rows={2}
                  placeholder="예: 조용한 한옥카페랑 무장애 되는 가까운 관광지가 좋아요"
                  className="w-full bg-hanji-deep border border-line rounded-2xl p-3 pr-11 text-xs text-muk placeholder:text-muk-soft outline-none focus:border-gold/60 resize-none"
                />
                <button
                  type="button"
                  onClick={isListening ? stopVoice : startVoice}
                  title="음성으로 말하기"
                  className={`absolute right-2 top-2 w-8 h-8 rounded-full flex items-center justify-center border transition-all ${
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
                className="w-full py-2.5 bg-gold/15 border border-gold/30 text-gold-deep rounded-xl font-bold text-xs transition-all hover:bg-gold/25 disabled:opacity-40"
              >
                {isParsingNl ? "AI 분석 중..." : "AI로 선호 분석하기 ✨"}
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
                  className="w-full py-2.5 bg-gradient-to-r from-jade to-gold text-white rounded-xl font-bold text-xs transition-all hover:opacity-90 active:scale-[0.98] shadow-sm"
                >
                  이 선호로 추천 받기 →
                </button>
              )}
            </div>

            {/* 구분선 */}
            <div className="flex items-center gap-3 text-[10px] text-muk-soft">
              <div className="flex-1 h-px bg-line" />
              또는 직접 선택
              <div className="flex-1 h-px bg-line" />
            </div>

            {/* Checkbox Grid */}
            <div className="grid grid-cols-2 gap-2">
              {categoriesList.map((cat) => {
                const isSelected = selectedOnboardingCats.includes(cat.id);
                return (
                  <button
                    key={cat.id}
                    onClick={() => {
                      if (isSelected) {
                        setSelectedOnboardingCats(selectedOnboardingCats.filter((id) => id !== cat.id));
                      } else {
                        setSelectedOnboardingCats([...selectedOnboardingCats, cat.id]);
                      }
                    }}
                    className={`p-3 rounded-2xl border text-xs font-semibold text-center transition-all duration-200 ${
                      isSelected
                        ? "bg-gold/15 border-gold text-muk shadow-sm"
                        : "bg-hanji-deep border-line text-muk-soft hover:border-gold/40 hover:text-muk"
                    }`}
                  >
                    {cat.label}
                  </button>
                );
              })}
            </div>

            {/* Submit onboarding Button */}
            <button
              onClick={handleOnboardingSubmit}
              disabled={selectedOnboardingCats.length < 3 || isOnboardingSubmitting}
              className="w-full py-3 bg-gradient-to-r from-gold to-terracotta text-white rounded-xl font-bold text-xs transition-all duration-300 hover:opacity-90 active:scale-[0.98] shadow-sm disabled:opacity-50"
            >
              {isOnboardingSubmitting ? "설정 저장 중..." : `선택 완료 (${selectedOnboardingCats.length}/3+)`}
            </button>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      
    </main>
  );
}

// Suspense wrapped Page Export
export default function RecommendPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-hanji text-muk flex items-center justify-center">
          <div className="text-muk-soft text-sm animate-pulse">추천 준비 중...</div>
        </div>
      }
    >
      <RecommendContent />
    </Suspense>
  );
}
