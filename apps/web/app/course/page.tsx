"use client";

// 분산 코스(멀티스톱 동선) 추천 페이지 — '배달 추적 화면' 스타일 지도+바텀시트 UI.
// 백엔드 POST /api/v1/courses/recommend 가 '도착 시각의 예측 혼잡'을 피해 2~3개 정류지로
// 이어지는 동선을 짜준다. sequence(종류 순서)를 보내면 그 순서대로, 안 보내면 자동으로 짠다.
// 이 페이지는 세션/위치를 얻어 호출하고, 결과를 지도 위 번호 마커 + 시트 목록으로 그린다.
// 정적 export(SSR) 안전: 모든 브라우저 API 접근은 useEffect/핸들러 내부에 둔다.

import { useState, useEffect, useCallback, useMemo, useRef, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Reorder } from "framer-motion";
import { ArrowLeft, ChevronDown, X, Navigation } from "lucide-react";
import { createPublicClient } from "@/lib/supabase";
import { apiClient, isAuthError } from "@/lib/api-client";
import { REGION, isWithinRegion } from "@/lib/region";
import { toast } from "sonner";
import { useT } from "@/lib/i18n/I18nProvider";
import { ShareButton } from "@/components/ShareButton";
import CourseMap from "@/components/CourseMap";
import NowChip from "@/components/NowChip";
import OptimizationLoader from "@/components/OptimizationLoader";
import { encodeStops, parseShareParam } from "@/lib/course-share";
import { loadTravelContext } from "@/lib/travelContext";
import { recordActiveTrip } from "@/lib/visits";
import { track } from "@/lib/analytics";
import { openDrivingDirections, openWalkingDirections } from "@/lib/navigation";

type TFunc = (key: string, vars?: Record<string, string | number>) => string;

const supabase = createPublicClient();

// 데모 폴백 방문자 ID — explore/recommend 및 api-client 와 동일(세션 없을 때).
const MOCK_VISITOR_ID = "a2222222-2222-2222-2222-222222222222";

interface CourseStop {
  order: number;
  facility: {
    id: string;
    name: string;
    type: string;
    latitude: number;
    longitude: number;
    capacity?: number;
    currentCount?: number;
  };
  arrivalOffsetMin: number;
  predictedCongestion: number;
  spotScore: number;
  reason: string;
  openStatusAtArrival?: 'open_expected' | 'closing_soon' | 'closed_confirmed' | 'needs_confirmation';
  travelMinutes?: number | null;
}

// 순서 지정 피커에 담긴 한 칸. type 은 백엔드 sequence 슬롯 값, uid 는 프런트 전용 드래그 식별자
// (같은 종류를 두 번 담아도 framer-motion Reorder 가 값 충돌 없이 각 칸을 구분하도록 부여).
interface SequenceItem {
  uid: string;
  type: string;
}

const TYPE_OPTIONS = [
  { id: "restaurant", emoji: "🍴" },
  { id: "cafe", emoji: "☕" },
  { id: "attraction", emoji: "📸" },
  { id: "culture", emoji: "🏛️" },
];

// 순서 지정 피커 최대 슬롯 — 백엔드 sequence 상한(최대 3)과 동일.
const MAX_SEQUENCE = 3;

function typeEmoji(type: string): string {
  return TYPE_OPTIONS.find((o) => o.id === type)?.emoji ?? "📍";
}

// 스텝퍼 라벨용 — 긴 시설명을 고정폭 칸에 맞게 자른다.
function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// 혼잡 키/색 — 백엔드 _congestion_label 임계값과 통일(라벨은 congestion 네임스페이스로 번역).
function congestion(level: number): { key: string; cls: string } {
  if (level >= 0.75) return { key: "busy", cls: "text-terracotta bg-terracotta/10 border-terracotta/25" };
  if (level >= 0.5) return { key: "moderate", cls: "text-gold-deep bg-gold/10 border-gold/25" };
  if (level >= 0.25) return { key: "relaxed", cls: "text-jade bg-jade/10 border-jade/25" };
  return { key: "quiet", cls: "text-jade bg-jade/15 border-jade/30" };
}

// 도착 오프셋(분) → 예상 시각(HH:MM, 24h) — 헤드라인 보조텍스트/시간행에서 공용으로 재사용.
function hhmm(offsetMin: number): string {
  const clock = new Date(Date.now() + offsetMin * 60_000);
  const hh = clock.getHours().toString().padStart(2, "0");
  const mm = clock.getMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

// 도착 오프셋(분) → 사람 친화 표기 + 예상 시각(HH:MM).
function arrivalText(offsetMin: number, t: TFunc): string {
  if (offsetMin < 8) return `${t("course.arrivalNow")} · ${hhmm(offsetMin)}`;
  return `${t("course.arrivalAfter", { min: Math.round(offsetMin) })} · ${hhmm(offsetMin)}`;
}

function CourseContent() {
  const t = useT();
  const searchParams = useSearchParams();

  // 공유 딥링크(?s=) 감지 — 있으면 '공유 모드'(읽기 전용, 순서 피커/종류 필터 숨김, 새 추천 호출 없음).
  // parseShareParam 은 깨진 조각을 걸러내므로, s 가 있어도 유효한 정류지가 하나도 없으면 일반 모드로 처리.
  const shareParam = searchParams.get("s");
  const parsed = useMemo(() => parseShareParam(shareParam), [shareParam]);
  const parsedShare = parsed.stops;
  // 공유 후 경과 분 — 링크에 실린 공유 시각으로 계산(옛 포맷/미상은 0 취급). 도착 오프셋 보정과
  // 배너의 '{n}분 전 공유됨' 표기에 쓴다(오래된 링크가 방금 계산된 것처럼 보이는 왜곡 방지).
  const sharedElapsedMin = useMemo(() => {
    if (parsed.sharedAtMin == null) return 0;
    return Math.max(0, Math.floor(Date.now() / 60_000) - parsed.sharedAtMin);
  }, [parsed.sharedAtMin]);
  const isShareMode = parsedShare.length > 0;

  const [userId, setUserId] = useState<string | null>(null);
  const [coords, setCoords] = useState<{ lat: number; lng: number }>({
    lat: REGION.center.lat,
    lng: REGION.center.lng,
  });
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  // 순서 지정 피커 상태 — 1개 이상이면 '순서 모드'(fetchCourse 가 body.sequence 를 보낸다).
  const [sequence, setSequence] = useState<SequenceItem[]>([]);
  const [stops, setStops] = useState<CourseStop[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);
  // 결과 뷰: 'cards'(정보 행 목록, 기본) | 'gantt'(시간축 간트차트)
  const [viewMode, setViewMode] = useState<"cards" | "gantt">("cards");
  // 최초 로드 완료 여부 — 전면 스켈레톤은 '첫 로드'에만 쓴다. 이후 재조회(칩 탭·드래그·위치 갱신)는
  // 페이지를 유지한 채 결과 영역만 흐리게(인라인 갱신) 표시한다. 전면 교체하면 순서 피커가
  // 언마운트되어 드래그가 끊기고(폼-리셋 감각), 지도도 매번 재초기화되어 깜빡인다.
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);

  // 공유 모드 전용 상태 — facilities 조회로 복원한 정류지(이름/좌표는 조회 시점 최신, 오프셋/혼잡은
  // 공유 시점 스냅샷). sharedLoading 초기값은 공유 모드일 때만 true 로 시작해 첫 프레임 빈 상태 깜빡임을 막는다.
  const [sharedStops, setSharedStops] = useState<CourseStop[]>([]);
  const [sharedLoading, setSharedLoading] = useState<boolean>(() => isShareMode);
  const [sharedError, setSharedError] = useState<string | null>(null);

  // 1) 세션(사용자 ID) — SessionBootstrap 익명 세션이 잡히면 실제 per-device id.
  //    주의: 첫 진입 시 로컬 세션이 아직 없어도 익명 로그인(레이아웃 SessionBootstrap)이 '진행 중'일 수
  //    있다. 이때 곧바로 MOCK_VISITOR_ID 로 fetch 를 쏘면 토큰 없는 요청이 401 → '로그인 필요' 화면이
  //    잠깐 떴다가 사라지는 플래시가 생긴다. 그래서 데모 폴백은 유예(2.5초) 후 '그때도 세션이 없을 때만'
  //    적용한다(setUserId 함수형 갱신으로 실제 id 가 이미 잡혔으면 덮어쓰지 않음).
  useEffect(() => {
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    const armFallback = () => {
      fallbackTimer = setTimeout(() => {
        setUserId((prev) => prev ?? MOCK_VISITOR_ID);
      }, 2500);
    };

    supabase.auth
      .getSession()
      .then(({ data: { session } }) => {
        if (session?.user) setUserId(session.user.id);
        else armFallback();
      })
      .catch(() => {
        // 인증 서버 미도달 등 — 동일하게 유예 후 데모 방문자 폴백.
        armFallback();
      });

    // 익명 세션이 뒤늦게 부트스트랩되면 실제 id 로 승격 → fetchCourse 재실행. body user_id 와 첨부 토큰이
    // 같은 세션에서 나오므로 백엔드 IDOR 가드(req.user_id == JWT sub)와 정합하게 유지된다.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) setUserId(session.user.id);
    });
    return () => {
      if (fallbackTimer) clearTimeout(fallbackTimer);
      subscription?.unsubscribe?.();
    };
  }, []);

  // 2) 위치 — 브라우저 Geolocation, 서비스 지역 밖이면 지역 중심으로 모킹(explore/recommend 와 동일).
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        let { latitude: lat, longitude: lng } = pos.coords;
        if (!isWithinRegion(lat, lng)) {
          lat = REGION.center.lat;
          lng = REGION.center.lng;
        }
        setCoords({ lat, lng });
      },
      () => {
        // 권한 거부/실패 → 지역 중심 기본값 유지 + 조용히 안내(무음 폴백 방지).
        toast.info(t("map.locationFallback"));
      }
    );
  }, [t]);

  // 3) 코스 조회 — sequence(순서 모드)가 있으면 body.sequence, 없으면 selectedTypes(자동 모드,
  //    종류 필터만 지정)를 보낸다. 두 모드는 서로 배타적(간섭 방지, OrderPicker 주석 참조).
  //    공유 모드에서는 새 추천을 호출하지 않는다(읽기 전용) — isShareMode 가드.
  // 요청 세대 카운터 — 겹쳐 나간 요청의 '구세대 응답'이 늦게 도착해 최신 화면을 덮어쓰지 않게 한다
  // (디바운스가 대부분 막지만, 초기 로드 직후나 500ms 를 넘는 네트워크 지연에서는 여전히 겹칠 수 있다).
  const fetchGenRef = useRef(0);

  const fetchCourse = useCallback(async () => {
    if (!userId || isShareMode) return;
    const gen = ++fetchGenRef.current;
    setLoading(true);
    setError(null);
    setNeedsAuth(false);
    try {
      const body: Record<string, unknown> = {
        userId,
        userLat: coords.lat,
        userLng: coords.lng,
        context: loadTravelContext(),
      };
      if (sequence.length > 0) {
        body.sequence = sequence.map((s) => s.type);
      } else if (selectedTypes.length > 0) {
        body.types = selectedTypes;
      }
      const data: CourseStop[] = await apiClient.post("/api/v1/courses/recommend", body);
      if (gen !== fetchGenRef.current) return; // 이후 요청이 이미 나감 — 구세대 응답 폐기
      setStops(Array.isArray(data) ? data : []);
    } catch (err) {
      if (gen !== fetchGenRef.current) return;
      console.warn("코스 추천 호출 실패:", err);
      setStops([]);
      // 401(인증 필요)은 서버 장애가 아니다 → 성공할 수 없는 '다시 시도' 대신 정직한 안내.
      if (isAuthError(err)) {
        setNeedsAuth(true);
      } else {
        setError(t("course.fetchError"));
      }
    } finally {
      if (gen === fetchGenRef.current) {
        setLoading(false);
        setHasLoadedOnce(true);
      }
    }
  }, [userId, coords.lat, coords.lng, selectedTypes, sequence, isShareMode, t]);

  // 재조회 디바운스 — framer-motion onReorder 는 '드래그 도중' 순서가 바뀔 때마다 연속 발화하고,
  // 종류 칩도 연타로 담는다. 변경마다 즉시 fetch 하면 그때마다 리렌더/로딩이 끼어들어 드래그가 끊기므로
  // 마지막 변경 후 500ms 에 한 번만 호출한다(최초 로드는 지연 없이 즉시).
  useEffect(() => {
    const delay = hasLoadedOnce ? 500 : 0;
    const timer = setTimeout(() => { fetchCourse(); }, delay);
    return () => clearTimeout(timer);
    // hasLoadedOnce 는 지연 시간 선택용일 뿐 — 값 변화가 재조회를 트리거하면 첫 로드 직후
    // 불필요한 2차 호출이 생기므로 의도적으로 deps 에서 제외한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchCourse]);

  // 3b) 공유 모드 정류지 복원 — anon RLS(createPublicClient)로 facilities 를 id in (...) 조회해
  //     이름/좌표는 조회 시점 최신값으로, 도착 오프셋/혼잡은 공유 시점 스냅샷(parsedShare) 그대로 채운다.
  //     spotScore/reason 은 URL 에 싣지 않는 값이라 정직하게 비워두고, StopRow 가 readOnly 일 때 숨긴다.
  const fetchSharedStops = useCallback(async () => {
    if (parsedShare.length === 0) {
      setSharedStops([]);
      setSharedLoading(false);
      return;
    }
    setSharedLoading(true);
    setSharedError(null);
    try {
      const ids = parsedShare.map((p) => p.id);
      const { data, error: qError } = await supabase
        .from("facilities")
        .select("id, name, type, latitude, longitude")
        .in("id", ids);
      if (qError) throw qError;
      const byId = new Map<string, any>((data || []).map((f: any): [string, any] => [f.id, f]));
      const rebuilt: CourseStop[] = parsedShare
        .map((p): CourseStop | null => {
          const f = byId.get(p.id);
          if (!f) return null;
          return {
            order: 0, // 필터링 뒤 일괄 재부여(중간 시설이 삭제돼도 1,2,3… 연속 순번 유지)
            facility: {
              id: f.id,
              name: f.name,
              type: f.type,
              latitude: f.latitude,
              longitude: f.longitude,
            },
            // 도착 오프셋은 공유 후 경과 시간만큼 보정한다 — 2시간 지난 링크의 '12분 뒤'가
            // 현재 시각 기준 절대시각으로 재계산되어 방금 계산된 것처럼 보이는 왜곡 방지.
            // 이미 지난 정류지는 0 으로 클램프(배너의 '{n}분 전 공유됨' 표기가 맥락을 준다).
            arrivalOffsetMin: Math.max(0, p.offsetMin - sharedElapsedMin),
            predictedCongestion: p.congestion,
            spotScore: 0,
            reason: "",
          };
        })
        .filter((x): x is CourseStop => x !== null)
        .map((s, i) => ({ ...s, order: i + 1 }));
      setSharedStops(rebuilt);
    } catch (err) {
      console.warn("공유 코스 복원 실패:", err);
      setSharedStops([]);
      setSharedError(t("course.sharedError"));
    } finally {
      setSharedLoading(false);
      // 주의: 여기서 hasLoadedOnce 를 올리면 안 된다. 공유 모드에서는 일반 모드 loading 이
      // 초기값 true 로 잔존하므로(fetchCourse 가 isShareMode 가드로 early-return), 배너 CTA 로
      // /course 전환 시 스켈레톤 게이트(activeLoading && !hasLoadedOnce)가 뚫려 흐린
      // EmptyState('결과 없음')가 첫 조회 동안 오표시된다. hasLoadedOnce 는 일반 모드
      // fetchCourse 완료에서만 올린다(공유 모드 재조회는 어차피 전면 스켈레톤이 종전 동작).
    }
  }, [parsedShare, sharedElapsedMin, t]);

  useEffect(() => {
    if (!isShareMode) return;
    fetchSharedStops();
  }, [isShareMode, fetchSharedStops]);

  // 3c) 공유 유입 계측 — 공유 링크(?s=)로 들어온 방문을 무인증 이벤트로 1회 기록한다.
  //     fire-and-forget: 실패해도 페이지 동작에 영향 없음(사용자에게 에러 노출 안 함).
  useEffect(() => {
    if (searchParams.get("s")) {
      apiClient
        .post("/api/v1/events/track", { event: "course_share_visit", props: { ref: "share" } })
        .catch(() => { /* 계측 실패는 조용히 무시 */ });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleType = (id: string) => {
    setSelectedTypes((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const addToSequence = (type: string) => {
    setSequence((prev) => {
      if (prev.length >= MAX_SEQUENCE) return prev;
      const uid = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      return [...prev, { uid, type }];
    });
  };
  const removeFromSequence = (uid: string) => {
    setSequence((prev) => prev.filter((s) => s.uid !== uid));
  };

  // 공유 모드 여부에 따라 렌더에 쓸 정류지/로딩/에러를 단일화 — 이하 JSX 는 이 값만 참조한다.
  const activeStops = isShareMode ? sharedStops : stops;
  const activeLoading = isShareMode ? sharedLoading : loading;
  const activeError = isShareMode ? sharedError : error;
  const lastStop = activeStops.length > 0 ? activeStops[activeStops.length - 1] : null;

  // 공유 링크 URL — 현재 코스(activeStops)가 있으면 정류지를 압축 인코딩해 ?s= 로 싣는다.
  // 없으면 undefined 를 넘겨 ShareButton 이 기존 동작(현재 페이지 URL)으로 폴백하게 둔다.
  // window 접근은 정적 export 프리렌더(SSR, window 없음) 안전을 위해 typeof 가드 필수.
  const shareUrl = useMemo(() => {
    if (activeStops.length === 0 || typeof window === "undefined") return undefined;
    const encoded = encodeStops(
      activeStops.map((s) => ({
        id: s.facility.id,
        offsetMin: s.arrivalOffsetMin,
        congestion: s.predictedCongestion,
      }))
    );
    return `${window.location.origin}/course?s=${encodeURIComponent(encoded)}&ref=share`;
  }, [activeStops]);

  return (
    <main className="min-h-screen bg-hanji text-muk relative overflow-hidden">
      {/* 배경 노을·금빛 광원 — 지도가 자리를 채우므로 평소엔 가려지고, 지도 폴백(unavailable) 시에만 은은히 비친다. */}
      <div className="absolute top-[-20%] left-[-10%] w-[520px] h-[520px] rounded-full bg-sunset-1/10 blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[520px] h-[520px] rounded-full bg-gold/10 blur-[120px] pointer-events-none" />

      {activeLoading && !hasLoadedOnce ? (
        <CourseSkeleton mode={isShareMode ? "shared" : "course"} />
      ) : (
        <div className="relative z-10">
          {/* 지도 + 플로팅 버튼(뒤로/공유) — CourseMap 이 null 을 반환하면(키 부재 등) 이 블록은
              0 높이로 접혀 시트가 자연히 위로 붙는다(무해 폴백). */}
          <div className="relative">
            <CourseMap stops={activeStops} userLocation={coords} />
            <Link
              href="/main"
              aria-label={t('course.backToMap')}
              className="absolute top-4 left-4 z-20 flex items-center justify-center w-10 h-10 rounded-full bg-white/90 backdrop-blur border border-line shadow-[0_2px_10px_rgba(43,35,32,0.15)] text-muk hover:bg-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
            >
              <ArrowLeft size={18} />
            </Link>
            <div className="absolute top-4 right-4 z-20">
              <ShareButton
                title={t('course.title')}
                text={t('common.shareCourse')}
                url={shareUrl}
                className="shadow-[0_2px_10px_rgba(43,35,32,0.15)]"
              />
            </div>
          </div>

          {/* 바텀시트 — 배민 배달 추적 화면 문법(그랩바 + rounded-t-3xl + -mt-6 겹침). */}
          <div className="relative -mt-6 rounded-t-3xl bg-white shadow-[0_-8px_30px_rgba(43,35,32,0.12)]">
            <div className="w-12 h-1.5 rounded-full bg-line mx-auto mt-3" aria-hidden />

            <div className="mx-auto w-full max-w-md md:max-w-2xl px-4 md:px-6 pt-4 pb-10 space-y-6">
              {/* 공유 모드 배너 — '공유받은 코스' 명시 + 내 위치로 새 코스 받기(param 제거 라우팅). */}
              {isShareMode && <SharedBanner elapsedMin={sharedElapsedMin} />}

              {/* 헤더 블록: 브랜드 칩 → 헤드라인(+도착 보조텍스트) → 한 줄 설명.
                  정류지가 아직 없으면(로딩 직후 빈 결과/에러/인증 등) 기존 제목/설명으로 폴백. */}
              <section className="space-y-2">
                {/* 브랜드 칩 + 현재 시각 — 도착 예정시각(headlineEta)이 어느 시점 기준인지 명시(혼동 방지). */}
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center w-fit px-2.5 py-1 rounded-full bg-gold/10 border border-gold/25 text-[11px] font-bold text-gold-deep">
                    {t('course.brand')}
                  </span>
                  <NowChip />
                </div>
                {activeStops.length > 0 && lastStop ? (
                  <>
                    <div className="flex items-end justify-between gap-3">
                      <h1 className="text-xl md:text-2xl font-serif font-bold text-muk leading-tight">
                        {t('course.headline', { n: activeStops.length })}
                      </h1>
                      <span className="shrink-0 text-xs font-semibold text-muk-soft tabular-nums pb-0.5">
                        {t('course.headlineEta', { time: hhmm(lastStop.arrivalOffsetMin) })}
                      </span>
                    </div>
                    <p className="text-xs md:text-sm text-muk-soft leading-relaxed">
                      {t('course.subline')}
                    </p>
                  </>
                ) : (
                  <>
                    <h1 className="text-lg md:text-xl font-serif font-bold text-muk">
                      {t('course.title')}
                    </h1>
                    <p className="text-xs md:text-sm text-muk-soft leading-relaxed">
                      {t('course.desc')}
                    </p>
                  </>
                )}
              </section>

              {/* 가로 스텝퍼 — 정류지가 있을 때만 */}
              {activeStops.length > 0 && <CourseStepper stops={activeStops} />}

              {/* 순서 지정 피커 — 공유 모드(읽기 전용)에서는 숨김(간섭 방지). */}
              {!isShareMode && (
                <OrderPicker
                  sequence={sequence}
                  onAdd={addToSequence}
                  onRemove={removeFromSequence}
                  onReorder={setSequence}
                  onReset={() => setSequence([])}
                  selectedTypes={selectedTypes}
                  onToggleType={toggleType}
                />
              )}

              {/* 결과 — 공유 모드는 needsAuth 대상이 아니므로(새 추천 호출 자체가 없음) 그 앞단에서 갈린다.
                  인라인 갱신: 재조회 중에는 이전 결과를 유지한 채 흐리게만 표시(전면 스켈레톤 금지 —
                  순서 피커/지도가 언마운트되지 않아 드래그·조작이 끊기지 않는다). */}
              <div
                className={`transition-opacity duration-200 ${activeLoading ? "opacity-50 pointer-events-none" : ""}`}
                aria-busy={activeLoading}
              >
                {!isShareMode && needsAuth ? (
                  <AuthState />
                ) : activeError ? (
                  <ErrorState message={activeError} onRetry={isShareMode ? fetchSharedStops : fetchCourse} />
                ) : activeStops.length === 0 ? (
                  <EmptyState />
                ) : (
                  <div className="space-y-4">
                    <ViewToggle mode={viewMode} onChange={setViewMode} />
                    {viewMode === "gantt" ? (
                      <CourseGantt stops={activeStops} />
                    ) : (
                      <StopRows stops={activeStops} readOnly={isShareMode} />
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

// Suspense 래핑 — useSearchParams(?s= 감지)는 클라이언트 전용 훅이라 정적 export(output:'export')
// 빌드에서 CSR bailout 을 피하려면 반드시 Suspense 경계 안에서 써야 한다(explore/recommend 페이지와 동일 관례).
// 폴백은 실제 레이아웃과 동일한 CourseSkeleton 을 재사용해 레이아웃 시프트를 없앤다.
export default function CoursePage() {
  return (
    <Suspense fallback={<CourseSkeleton mode="course" />}>
      <CourseContent />
    </Suspense>
  );
}

// 공유 모드 상단 배너 — '공유받은 코스'임과 표기 시각 기준을 명시하고, 자기 위치 기준 새 코스로
// 전환하는 CTA 를 준다. href="/course" 는 쿼리(?s=...) 없는 일반 모드 경로로 이동(Link, 클라이언트 라우팅).
function SharedBanner({ elapsedMin = 0 }: { elapsedMin?: number }) {
  const t = useT();
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-gold/25 bg-gold/10 px-3 py-2.5">
      <p className="text-[11px] font-semibold text-gold-deep leading-snug">
        {t('course.sharedBanner')}
        {/* 5분 이상 지난 링크는 경과 시간을 명시해 '방금 계산된 코스'로 오인하지 않게 한다. */}
        {elapsedMin >= 5 && <> · {t('course.sharedAgo', { min: elapsedMin })}</>}
      </p>
      <Link
        href="/course"
        className="shrink-0 inline-flex items-center px-3 py-1.5 rounded-full bg-white border border-gold/30 text-[11px] font-bold text-gold-deep hover:bg-gold/5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/50"
      >
        {t('course.sharedCta')}
      </Link>
    </div>
  );
}

// 가로 스텝퍼 — 정류지 순서를 한눈에 미리보기. '지금부터 갈 순서'이므로 완료 표시는 없고,
// 첫 정류지만 강조(gold 채움 + 굵은 라벨)하고 이후는 회색으로 낮춘다.
function CourseStepper({ stops }: { stops: CourseStop[] }) {
  const t = useT();
  return (
    <ol className="flex items-start w-full" aria-label={t('course.stepperAria')}>
      {stops.map((stop, idx) => {
        const isFirst = idx === 0;
        return (
          // 정류지 1개면 li 가 flex-1 로 전체 폭을 차지해 좌측에 쏠린다 → 가운데 정렬로 보정.
          <li key={stop.facility.id} className={`flex items-start flex-1 min-w-0 ${stops.length === 1 ? "justify-center" : ""}`}>
            {idx > 0 && <span className="h-0.5 bg-line flex-1 mt-4 mx-1" aria-hidden />}
            <div className="flex flex-col items-center gap-1 w-16 shrink-0 min-w-0">
              <span
                className={`flex items-center justify-center w-8 h-8 rounded-full text-sm border-2 shrink-0 ${
                  isFirst ? "bg-gold border-gold text-white" : "bg-white border-line text-muk-soft"
                }`}
                aria-hidden
              >
                {typeEmoji(stop.facility.type)}
              </span>
              <span
                className={`text-[10px] max-w-full truncate text-center ${
                  isFirst ? "font-bold text-muk" : "text-muk-soft"
                }`}
                title={stop.facility.name}
              >
                {truncate(stop.facility.name, 6)}
              </span>
              <span className="text-[9px] text-muk-soft/80 tabular-nums">
                {t('course.stepperOffset', { min: Math.round(stop.arrivalOffsetMin) })}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// 순서 지정 피커 — 종류를 순서대로 눌러 담으면(sequence) 그 순서대로 코스를 배정한다(백엔드 body.sequence,
// 1번째 정류지=sequence[0] 종류 …). framer-motion Reorder 로 담긴 순서를 드래그 재정렬할 수 있다.
// sequence 가 1개 이상이면 '순서 모드'가 되어, 아래 기존 selectedTypes 멀티 필터(자동 모드용)는
// 렌더하지 않는다 — 두 입력이 동시에 보이면 어느 쪽이 적용되는지 헷갈리므로 간섭을 원천 차단.
function OrderPicker({
  sequence,
  onAdd,
  onRemove,
  onReorder,
  onReset,
  selectedTypes,
  onToggleType,
}: {
  sequence: SequenceItem[];
  onAdd: (type: string) => void;
  onRemove: (uid: string) => void;
  onReorder: (next: SequenceItem[]) => void;
  onReset: () => void;
  selectedTypes: string[];
  onToggleType: (id: string) => void;
}) {
  const t = useT();
  return (
    <section className="space-y-2.5">
      <div>
        <h2 className="text-sm font-bold text-muk">{t('course.orderTitle')}</h2>
        <p className="text-[11px] text-muk-soft mt-0.5">{t('course.orderHint')}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {TYPE_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            type="button"
            onClick={() => onAdd(opt.id)}
            disabled={sequence.length >= MAX_SEQUENCE}
            aria-label={t('course.orderAddAria', { type: t(`category.${opt.id}`) })}
            className="px-3 py-1.5 rounded-full text-xs font-semibold border bg-white border-line text-muk-soft hover:border-gold/40 hover:text-gold-deep transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/50"
          >
            {opt.emoji} {t(`category.${opt.id}`)}
          </button>
        ))}
      </div>

      {sequence.length > 0 && (
        <div className="space-y-2">
          {/* axis="x" 드래그는 줄바꿈(wrap)되면 순서 계산이 깨진다 → 한 줄 고정(nowrap).
              넘칠 때는 칩이 min-w-0 로 줄어들고 라벨만 truncate — 조상 main 이 overflow-hidden 이라
              가로 스크롤 복구 경로가 없으므로, 좁은 폰·긴 로케일(en 'Restaurant' 등)에서도
              ✕(제거) 버튼이 항상 화면 안에 남아야 한다.
              touch-none: 모바일에서 핀 터치가 페이지 세로 스크롤로 새지 않아야 드래그가 시작된다. */}
          <Reorder.Group
            axis="x"
            values={sequence}
            onReorder={onReorder}
            className="flex flex-nowrap gap-2"
          >
            {sequence.map((item, idx) => (
              <Reorder.Item
                key={item.uid}
                value={item}
                className="flex items-center gap-1.5 pl-2.5 pr-1.5 py-1.5 min-w-0 rounded-full bg-gold/15 border border-gold/40 text-gold-deep text-xs font-bold cursor-grab active:cursor-grabbing select-none touch-none"
              >
                <span className="tabular-nums shrink-0">{idx + 1}.</span>
                <span className="truncate min-w-0">{typeEmoji(item.type)} {t(`category.${item.type}`)}</span>
                <button
                  type="button"
                  onClick={() => onRemove(item.uid)}
                  aria-label={t('course.orderRemoveAria', { type: t(`category.${item.type}`) })}
                  className="ml-0.5 p-0.5 shrink-0 rounded-full hover:bg-gold/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/50"
                >
                  <X size={12} />
                </button>
              </Reorder.Item>
            ))}
          </Reorder.Group>
          <button
            type="button"
            onClick={onReset}
            className="text-[11px] font-semibold text-muk-soft hover:text-terracotta transition-colors underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/50 rounded"
          >
            {t('course.orderReset')}
          </button>
        </div>
      )}

      {/* 기존 종류 멀티 필터(자동 모드용) — 순서 모드(sequence 1개 이상)와 간섭하지 않도록
          sequence 가 비어있을 때만 렌더한다. 위 '순서대로 담기' 칩과 모양이 같아 중복으로 보이던
          문제(UX): 라벨로 두 그룹의 의도를 구분한다(위=순서 담기, 아래=종류만 선택·순서 자동). */}
      {sequence.length === 0 && (
        <div className="pt-1.5 mt-1 border-t border-line/70 space-y-1.5">
          <p className="text-[11px] text-muk-soft">{t('course.typeFilterLabel')}</p>
          <div className="flex flex-wrap gap-2">
          {TYPE_OPTIONS.map((opt) => {
            const on = selectedTypes.includes(opt.id);
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => onToggleType(opt.id)}
                aria-pressed={on}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
                  on
                    ? "bg-gold/15 border-gold/40 text-gold-deep"
                    : "bg-white border-line text-muk-soft hover:border-gold/30"
                }`}
              >
                {opt.emoji} {t(`category.${opt.id}`)}
              </button>
            );
          })}
          </div>
        </div>
      )}
    </section>
  );
}

// 카드(목록) ↔ 간트 뷰 전환 세그먼트 컨트롤.
function ViewToggle({ mode, onChange }: { mode: "cards" | "gantt"; onChange: (m: "cards" | "gantt") => void }) {
  const t = useT();
  const opts: { id: "cards" | "gantt"; label: string }[] = [
    { id: "cards", label: t("course.viewList") },
    { id: "gantt", label: t("course.viewGantt") },
  ];
  return (
    <div className="inline-flex items-center gap-1 p-1 rounded-full border border-line bg-white" role="tablist" aria-label={t("course.title")}>
      {opts.map((o) => {
        const on = mode === o.id;
        return (
          <button
            key={o.id}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(o.id)}
            className={`px-3.5 py-1.5 rounded-full text-xs font-bold transition-colors ${
              on ? "bg-gold text-white shadow-[0_2px_8px_rgba(193,154,62,0.3)]" : "text-muk-soft hover:text-muk"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// 간트차트 — 시간축(지금~마지막 체류)에 각 정류지를 도착~다음 도착 구간의 가로 막대로 배치.
// 막대 색은 도착 시점 예측 혼잡도. 마지막 정류지는 기본 체류시간(DWELL_LAST)을 폭으로 준다.
// 데이터 한계: 정류지별 정확한 체류/출발 시각은 백엔드가 주지 않으므로 '도착 간격'을 구간으로 근사한다(정직 표기).
const DWELL_LAST_MIN = 45;
function CourseGantt({ stops }: { stops: CourseStop[] }) {
  const t = useT();
  const segments = stops.map((s, i) => {
    const start = Math.max(0, s.arrivalOffsetMin);
    const rawEnd = i < stops.length - 1 ? stops[i + 1].arrivalOffsetMin : s.arrivalOffsetMin + DWELL_LAST_MIN;
    return { s, start, end: Math.max(rawEnd, start + 10) }; // 최소 10분 폭 보장
  });
  const total = Math.max(...segments.map((x) => x.end), 30);

  // 시간 눈금 5개(균등) — 지금 기준 실제 시각(HH:MM)으로 표기.
  const ticks = Array.from({ length: 5 }, (_, i) => {
    const min = (total * i) / 4;
    return { pct: (min / total) * 100, label: i === 0 ? t("course.ganttNow") : hhmm(min) };
  });

  return (
    <div className="bg-white rounded-2xl border border-line shadow-[0_2px_14px_rgba(43,35,32,0.06)] p-4 md:p-5 space-y-3">
      <p className="text-[11px] text-muk-soft font-medium">{t("course.ganttHint")}</p>

      {/* 시간 눈금(트랙 전체폭 기준) — 양끝 라벨은 넘치지 않게 정렬 보정. */}
      <div className="relative h-4">
        {ticks.map((tk, i) => (
          <span
            key={i}
            className={`absolute top-0 text-[10px] text-muk-soft/80 font-medium tabular-nums whitespace-nowrap ${
              i === 0 ? "" : i === ticks.length - 1 ? "-translate-x-full" : "-translate-x-1/2"
            }`}
            style={{ left: `${tk.pct}%` }}
          >
            {tk.label}
          </span>
        ))}
      </div>

      {/* 정류지 행 — 이름을 막대 위 '전체폭' 라벨로 올려 긴 이름 잘림을 해소(고정폭 칸 제거).
          그래도 넘치는 초장문은 truncate + title 툴팁으로 폴백. 막대는 아래 시간축에 정렬. */}
      <div className="space-y-3">
        {segments.map(({ s, start, end }) => {
          const cong = congestion(s.predictedCongestion);
          const leftPct = (start / total) * 100;
          const widthPct = ((end - start) / total) * 100;
          return (
            <div key={s.facility.id} className="space-y-1">
              {/* 이름 라벨(전체폭) + 도착 시각 */}
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-[11px] font-bold text-muk" title={s.facility.name}>
                  {s.order}. {typeEmoji(s.facility.type)} {s.facility.name}
                </span>
                <span className="shrink-0 text-[10px] text-muk-soft tabular-nums">
                  🕒 {arrivalText(s.arrivalOffsetMin, t)}
                </span>
              </div>
              {/* 시간축 트랙 + 막대 */}
              <div className="relative h-7 rounded-lg bg-hanji-deep/50 overflow-hidden">
                {/* 눈금 세로선(연하게) */}
                {ticks.map((tk, i) => (
                  <span key={i} className="absolute top-0 bottom-0 w-px bg-line/60" style={{ left: `${tk.pct}%` }} aria-hidden />
                ))}
                <div
                  className={`absolute top-1 bottom-1 rounded-md border flex items-center px-2 min-w-[2.5rem] ${cong.cls}`}
                  style={{ left: `${leftPct}%`, width: `calc(${widthPct}% - 2px)` }}
                  title={`${s.facility.name} · ${arrivalText(s.arrivalOffsetMin, t)}`}
                >
                  <span className="text-[10px] font-bold tabular-nums">
                    {Math.round(s.predictedCongestion * 100)}%
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* 범례 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-[10px] text-muk-soft">
        {(["quiet", "relaxed", "moderate", "busy"] as const).map((k) => {
          const cls = { quiet: "bg-jade/15 border-jade/30", relaxed: "bg-jade/10 border-jade/25", moderate: "bg-gold/10 border-gold/25", busy: "bg-terracotta/10 border-terracotta/25" }[k];
          return (
            <span key={k} className="inline-flex items-center gap-1">
              <span className={`w-2.5 h-2.5 rounded-sm border ${cls}`} aria-hidden />
              {t(`congestion.${k}`)}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// 정보 행 목록 — 배민 배달 추적 화면의 '배달주소/요청사항' 행 문법(카드 박스가 아니라 플랫한
// 시트 위 행 + divide-y 구분선). 시트 좌우 패딩을 상쇄(-mx)해 구분선이 시트 폭 끝까지 이어지게 한다.
// readOnly(공유 모드): spotScore/reason 은 공유 URL 에 싣지 않아 정직하게 알 수 없는 값이므로 숨긴다.
function StopRows({ stops, readOnly = false }: { stops: CourseStop[]; readOnly?: boolean }) {
  return (
    <div className="-mx-4 md:-mx-6 divide-y divide-line">
      {stops.map((stop) => (
        <StopRow key={stop.facility.id} stop={stop} readOnly={readOnly} />
      ))}
    </div>
  );
}

function StopRow({ stop, readOnly = false }: { stop: CourseStop; readOnly?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const cong = congestion(stop.predictedCongestion);
  const reasonId = `course-reason-${stop.facility.id}`;
  const startNavigation = (mode: 'walk' | 'car') => {
    const walkMinutes = stop.travelMinutes ?? stop.arrivalOffsetMin;
    recordActiveTrip(stop.facility, {
      walkMinutes,
      context: loadTravelContext() as unknown as Record<string, unknown>,
      navigationMode: mode,
    });
    track('navigation_started', {
      facility_type: stop.facility.type,
      navigation_mode: mode,
      walk_minutes: Math.round(walkMinutes),
    });
    if (mode === 'car') {
      toast.info(t('trip.driveBasisHint'));
      openDrivingDirections(stop.facility);
    } else {
      toast.info(t('trip.selectWalking'));
      openWalkingDirections(stop.facility);
    }
  };
  return (
    <div className="px-4 md:px-6 py-4">
      <div className="flex items-start gap-3">
        <span
          className="shrink-0 flex items-center justify-center w-9 h-9 rounded-full bg-hanji-deep text-base"
          aria-hidden
        >
          {typeEmoji(stop.facility.type)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-sm font-bold text-muk truncate">
              {stop.order}. {stop.facility.name}
            </h3>
            <span className={`shrink-0 px-2 py-0.5 rounded-lg text-[10px] font-bold border ${cong.cls}`}>
              {t(`congestion.${cong.key}`)} {Math.round(stop.predictedCongestion * 100)}%
            </span>
          </div>

          <div className="flex items-center gap-2 text-[11px] text-muk-soft mt-0.5">
            <span>🕒 {arrivalText(stop.arrivalOffsetMin, t)}</span>
            {!readOnly && (
              <>
                <span className="text-line">·</span>
                <span>{t('course.spotScore', { score: Math.round(stop.spotScore * 100) })}</span>
              </>
            )}
          </div>
          {stop.openStatusAtArrival && (
            <p className="mt-1 text-[10px] font-semibold text-muk-soft">{t(`card.arrivalStatus.${stop.openStatusAtArrival}`)}</p>
          )}

          {/* 이유 토글(왼쪽) + 길안내 버튼(오른쪽, ml-auto 로 항상 우측 정렬). 길안내는 새 탭으로 열리는
              순수 링크라 이유 토글과 클릭이 겹칠 일이 없지만, 혹시 모를 이벤트 버블링까지 stopPropagation 으로 차단. */}
          <div className="flex items-center gap-2 mt-1.5">
            {!readOnly && (
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                aria-controls={reasonId}
                className="flex items-center gap-1 text-[11px] font-semibold text-gold-deep hover:text-gold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/50 rounded"
              >
                {t('course.reasonToggle')}
                <ChevronDown size={13} className={`transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
              </button>
            )}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); startNavigation('walk'); }}
              aria-label={t('course.directionsAria', { name: stop.facility.name })}
              className="ml-auto shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-gold/30 bg-gold/10 text-[11px] font-bold text-gold-deep hover:bg-gold/20 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/50"
            >
              <Navigation size={11} aria-hidden />
              {t('course.directions')}
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); startNavigation('car'); }}
              aria-label={t('course.drivingAria', { name: stop.facility.name })}
              className="shrink-0 px-2 py-1 rounded-full border border-line bg-white text-[10px] font-bold text-muk-soft hover:border-gold/30 hover:text-gold-deep"
            >
              {t('course.driving')}
            </button>
          </div>

          {!readOnly && open && (
            <p id={reasonId} className="mt-1.5 text-xs text-muk leading-relaxed bg-hanji-deep/60 rounded-lg px-3 py-2">
              {stop.reason}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// 로딩 스켈레톤 — 실제 레이아웃(지도 자리 + 시트 헤더/스텝퍼/행)을 그대로 흉내내 레이아웃 시프트를 줄인다.
function CourseSkeleton({ mode }: { mode: "course" | "shared" }) {
  return (
    <div className="relative z-10" aria-hidden>
      {/* 지도 자리 */}
      <div className="h-[38dvh] md:h-[42dvh] w-full bg-hanji-deep animate-pulse" />

      {/* 시트 자리 */}
      <div className="relative -mt-6 rounded-t-3xl bg-white shadow-[0_-8px_30px_rgba(43,35,32,0.12)]">
        <div className="w-12 h-1.5 rounded-full bg-line mx-auto mt-3" />

        <div className="mx-auto w-full max-w-md md:max-w-2xl px-4 md:px-6 pt-4 pb-10 space-y-6">
          <OptimizationLoader mode={mode} />
          {/* 헤더 */}
          <div className="space-y-2">
            <div className="h-5 w-28 rounded-full bg-hanji-deep animate-pulse" />
            <div className="h-6 w-2/3 rounded-md bg-hanji-deep animate-pulse" />
            <div className="h-3 w-1/2 rounded-md bg-hanji-deep animate-pulse" />
          </div>

          {/* 스텝퍼 */}
          <div className="flex items-start gap-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex-1 flex flex-col items-center gap-1.5">
                <div className="w-8 h-8 rounded-full bg-hanji-deep animate-pulse" />
                <div className="h-2 w-10 rounded bg-hanji-deep animate-pulse" />
              </div>
            ))}
          </div>

          {/* 정보 행 */}
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-full bg-hanji-deep animate-pulse shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-2/3 rounded bg-hanji-deep animate-pulse" />
                  <div className="h-3 w-1/2 rounded bg-hanji-deep animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  const t = useT();
  return (
    <div className="bg-white rounded-2xl border border-line shadow-[0_2px_14px_rgba(43,35,32,0.06)] p-8 text-center space-y-2">
      <div className="text-3xl">🗺️</div>
      <p className="text-sm font-semibold text-muk">{t('course.emptyTitle')}</p>
      <p className="text-xs text-muk-soft leading-relaxed">
        {t('course.emptyBody')}
      </p>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  const t = useT();
  return (
    <div className="bg-white rounded-2xl border border-terracotta/25 shadow-[0_2px_14px_rgba(43,35,32,0.06)] p-8 text-center space-y-3">
      <div className="text-3xl">⚠️</div>
      <p className="text-sm font-semibold text-muk">{message}</p>
      <button
        onClick={onRetry}
        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-gold text-white text-xs font-bold hover:bg-gold-deep transition-colors"
      >
        {t('common.retry')}
      </button>
    </div>
  );
}

// 인증 필요(401) 상태 — 관광객 로그인이 없어 코스 추천 API 가 401 을 준다.
// '다시 시도'는 결코 성공하지 못하므로, 지도에서 추천을 받도록 정직하게 유도한다.
function AuthState() {
  const t = useT();
  return (
    <div className="bg-white rounded-2xl border border-gold/30 shadow-[0_2px_14px_rgba(43,35,32,0.06)] p-8 text-center space-y-3">
      <div className="text-3xl">🗺️</div>
      <p className="text-sm font-semibold text-muk">{t('course.authTitle')}</p>
      <p className="text-xs text-muk-soft leading-relaxed">{t('course.authBody')}</p>
      <Link
        href="/main"
        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-gold text-white text-xs font-bold hover:bg-gold-deep transition-colors"
      >
        {t('course.authCta')}
      </Link>
    </div>
  );
}
