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
import { apiClient, isAuthError, httpStatus } from "@/lib/api-client";
import { REGION, isWithinRegion } from "@/lib/region";
import { toast } from "sonner";
import { useT } from "@/lib/i18n/I18nProvider";
import { ErrorState } from "@/components/ErrorState";
import { ShareButton } from "@/components/ShareButton";
import CourseMap from "@/components/CourseMap";
import NowChip from "@/components/NowChip";
import OptimizationLoader from "@/components/OptimizationLoader";
import { encodeStops, parseShareParam } from "@/lib/courseShare";
import { describeReplan } from "@/lib/coursePlanDiff";
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
  predictedCongestion: number | null;
  spotScore: number;
  reason: string;
  openStatusAtArrival?: 'open_expected' | 'closing_soon' | 'closed_confirmed' | 'needs_confirmation';
  travelMinutes?: number | null;
  alternatives?: CourseAlternative[];
}

/** 같은 자리의 차점 후보.
 *
 * 서버가 1등을 뽑느라 어차피 전부 채점해 둔 것을 버리지 않고 실어 준 값이다. 도착 시각·예상
 * 혼잡은 **그 자리의 실제 출발점과 누적 도착 시각** 기준이라 그대로 보여 줘도 거짓이 아니다. */
interface CourseAlternative {
  facility: { id: string; name: string; type: string; latitude: number; longitude: number };
  arrivalOffsetMin: number;
  predictedCongestion: number | null;
  spotScore: number;
  travelMinutes?: number | null;
}

/** 사용자가 짠 자리 하나의 결과.
 *
 * 왜 필요한가: 응답의 order 는 **채운 것만으로** 1..n 다시 매겨진다. 그래서 3곳을 짰는데 2곳만
 * 왔을 때 어느 자리가 왜 빠졌는지 화면이 알 방법이 없었고, 개수 차이로 이유를 추측할 수밖에
 * 없었다. 추측한 이유를 사용자에게 말하는 것은 값을 지어내는 것과 같다. */
interface SlotOutcome {
  order: number;
  requestedType: string | null;
  status:
    | 'filled'
    | 'no_candidate_of_type'
    | 'closed_at_arrival'
    | 'late_night_unconfirmed'
    | 'over_time_budget'
    | 'pin_unavailable';
  facilityId: string | null;
  pinned: boolean;
}

interface CoursePlan {
  stops: CourseStop[];
  slotOutcomes: SlotOutcome[];
  /** 선택된 시설 id 열의 해시. '정말 바뀌었는지' 를 추측이 아니라 사실로 판정하는 근거다. */
  planId: string;
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
  const [slotOutcomes, setSlotOutcomes] = useState<SlotOutcome[]>([]);
  // 자리 고정. 키는 '자리'가 아니라 **피커 칸의 uid** 다 — 칩을 끌어 순서를 바꾸면 고정도 함께
  // 따라와야 하기 때문이다(자리 번호로 잡아 두면 카페를 3번으로 옮겨도 고정은 2번에 남는다).
  // 자동 모드에는 uid 가 없으므로 자리 번호로 만든 키를 쓴다(slotKey 참조).
  const [pins, setPins] = useState<Record<string, string>>({});
  // **이 응답을 만든 요청의** 자리 키. 화면의 행은 이 배열로 자리를 찾는다.
  //
  // slotKeys 는 sequence 에서 즉시 파생되는데 stops/slotOutcomes 는 500ms 디바운스 + 왕복
  // 뒤에야 갱신된다. 그 사이 결과 영역은 아직 클릭 가능해서(loading 이 false 다), 낡은 행이
  // **새 키 배열**을 들고 있었다 — 칩을 끌어 순서를 바꾼 직후 📌 를 누르면 핀이 엉뚱한
  // 자리에 꽂히고(서버는 핀 분기가 종류 분기보다 앞이라 카페 자리에 식당을 넣는다),
  // 칩을 지운 직후에는 키가 없어 버튼이 활성인 채 아무 일도 일어나지 않았다.
  const [renderedSlotKeys, setRenderedSlotKeys] = useState<string[]>([]);
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
  // 한 번이라도 요청을 **실제로 내보냈는가**(응답 도착 여부도, 타이머가 돌았는지도 아니다).
  // fetchCourse 의 가드를 통과한 뒤에 켠다 — 아래 디바운스 주석 참조.
  const dispatchedRef = useRef(false);

  // 고정을 붙들어 두는 키. 순서 모드에서는 피커 칸의 uid 다 — 칩을 끌어 순서를 바꾸면 고정도
  // 함께 따라와야 하기 때문이다(자리 번호로 잡으면 카페를 3번으로 옮겨도 고정은 2번에 남는다).
  // 자동 모드에는 uid 가 없으므로 자리 번호로 만든 키를 쓴다.
  const slotKeys = useMemo(
    () => (sequence.length > 0 ? sequence.map((item) => item.uid) : ["auto-0", "auto-1", "auto-2"]),
    [sequence],
  );

  const prevPlanRef = useRef<{ planId: string; ids: string[] } | null>(null);
  // 사용자가 조건을 바꿔서 나간 재조회인가. 위치 갱신·세션 승격 같은 배경 재조회에는 토스트를
  // 띄우지 않는다 — 사용자가 아무것도 안 했는데 "다시 짰어요" 라고 말하면 그것도 거짓말이다.
  const userReplanRef = useRef(false);

  /** 재조회 결과가 실제로 무엇이 달라졌는지 말한다.
   *
   * 지금까지 재조회의 유일한 신호는 결과 영역의 opacity-50 하나였다. 순서를 바꿨는데 같은 답이
   * 돌아오면 픽셀이 한 개도 안 바뀌어 '호출조차 안 나갔다' 로 읽혔다 — 사용자가 말한
   * "아무것도 안 바뀐다" 의 절반은 결과가 아니라 이 침묵에서 왔다.
   *
   * 다만 '바뀌었다' 고 말하고 싶은 유혹은 서버가 준 planId 로 막는다. 같으면 같다고 말한다. */
  const announceReplan = useCallback((planId: string, nextStops: CourseStop[]) => {
    const next = { planId, ids: nextStops.map((stop) => stop.facility.id) };
    const prev = prevPlanRef.current;
    prevPlanRef.current = next;
    if (!userReplanRef.current) return;
    userReplanRef.current = false;
    // 무엇이 달라졌는지 고르는 일은 lib/coursePlanDiff 가 한다(순수 판정이라 테스트로 잠긴다).
    // 여기서 직접 세던 시절, '추가' 만 세고 '제거' 를 빠뜨려 정류지가 사라진 재계획을
    // "같은 곳들을 순서만 바꿔 다시 계산했어요" 라고 말했다.
    const message = describeReplan(prev, next);
    if (!message) return;
    // 같은 id 를 재사용해 드래그 연타로 토스트가 쌓이지 않게 한다.
    toast(t(message.key, message.vars), { id: "course-replan" });
  }, [t]);

  const fetchCourse = useCallback(async () => {
    if (!userId || isShareMode) return;
    // **여기서** 켠다. 타이머 콜백에서 켜면 userId 가 아직 없어 곧바로 return 하는 호출에도
    // 켜져, 정작 첫 요청이 500ms 늦게 나갔다(세션 없는 첫 방문자는 2500+500ms). 콜드
    // 스타트가 얹히는 그 첫 왕복 앞에 붙는 순수 지연이었다.
    dispatchedRef.current = true;
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
      // 고정은 서버에 '자리 번호 → 시설' 로 보낸다. 화면이 uid 로 들고 있는 이유는 위 pins 주석 참조.
      const pinList = Object.entries(pins)
        .map(([key, facilityId]) => ({ order: slotKeys.indexOf(key) + 1, facilityId }))
        .filter((p) => p.order > 0);
      if (pinList.length > 0) body.pins = pinList;
      // 타임아웃을 명시한다(기본 10초 대신 20초). 코스 추천은 정류지마다 후보를 재평가하는
      // 멀티스톱 계산이라 단일 추천보다 본질적으로 무겁고, 백엔드 시설 캐시가 식은 첫 요청은
      // 여기에 더해 전체 시설을 다시 읽는다. 기본값 10초는 그 정상 범위와 너무 가까워,
      // 조금만 느려도 '분산 코스 전체 실패'로 보였다(2026-08-27 실측: 서버 ~10초 → 100% 실패).
      // 서버 쪽 병목은 availability_service 조회 분할로 별도 수정했고(~1초), 이 값은 그 위의 여유분이다.
      // /plan 은 정류지 + 자리별 결과 + planId 를 함께 준다. 구 API 는 이 경로를 모르므로
      // 404 면 기존 /recommend 로 내려간다 — Vercel(정적 export)과 Render 는 배포 시점이 다르고
      // 스테이징이 없어서, **새 화면이 먼저 뜨는 구간이 실제로 존재한다.** 그 구간에서 코스가
      // 통째로 실패하면 장애가 '갈 곳 없음' 으로 보인다(이 라우터가 가장 피하려는 종류의 거짓말).
      let plan: CoursePlan;
      try {
        plan = await apiClient.post("/api/v1/courses/plan", body, { timeoutMs: 20000 });
      } catch (planErr) {
        if (httpStatus(planErr) !== 404) throw planErr;
        const legacy: CourseStop[] = await apiClient.post("/api/v1/courses/recommend", body, { timeoutMs: 20000 });
        // planId 가 빈 문자열이면 '판정할 근거가 없다' 는 뜻이다 — 아래에서 토스트를 띄우지 않는다.
        plan = { stops: Array.isArray(legacy) ? legacy : [], slotOutcomes: [], planId: "" };
      }
      if (gen !== fetchGenRef.current) return; // 이후 요청이 이미 나감 — 구세대 응답 폐기
      const nextStops = Array.isArray(plan?.stops) ? plan.stops : [];
      announceReplan(plan?.planId ?? "", nextStops);
      setStops(nextStops);
      setSlotOutcomes(Array.isArray(plan?.slotOutcomes) ? plan.slotOutcomes : []);
      // 결과와 **같은 배치로** 자리 키를 굳힌다(위 renderedSlotKeys 주석 참조).
      setRenderedSlotKeys(slotKeys);
    } catch (err) {
      if (gen !== fetchGenRef.current) return;
      console.warn("코스 추천 호출 실패:", err);
      setStops([]);
      // 실패는 '자리를 못 채웠다' 와 다르다. 낡은 사유를 남겨 두면 장애를 조건 문제로 읽게 된다.
      setSlotOutcomes([]);
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
  }, [userId, coords.lat, coords.lng, selectedTypes, sequence, pins, slotKeys, isShareMode, announceReplan, t]);

  // 재조회 디바운스 — framer-motion onReorder 는 '드래그 도중' 순서가 바뀔 때마다 연속 발화하고,
  // 종류 칩도 연타로 담는다. 변경마다 즉시 fetch 하면 그때마다 리렌더/로딩이 끼어들어 드래그가 끊기므로
  // 마지막 변경 후 500ms 에 한 번만 호출한다(실제 첫 요청은 지연 없이 즉시).
  useEffect(() => {
    // 지연 판정을 '완료' 가 아니라 **'이미 한 번 발사했는가'** 로 한다(발사 = fetchCourse 의
    // 가드를 통과해 실제 요청이 나갔다는 뜻. 타이머가 돌기만 한 것은 발사가 아니다).
    // hasLoadedOnce 는 응답이 와야 true 가 되는데, 그 전에 geolocation 이 풀리면 coords 가
    // 바뀌어 이펙트가 다시 돌고 그때도 delay 0 이라 **두 번째 요청이 곧바로 나갔다.**
    // 첫 응답은 fetchGenRef 로 버려지지만 서버는 이미 다 계산한 뒤다(취소 수단이 없다) —
    // 위치를 허용한 사용자의 모든 첫 진입에서 단일 워커가 코스를 두 벌 돌렸다.
    const delay = dispatchedRef.current ? 500 : 0;
    const timer = setTimeout(() => { fetchCourse(); }, delay);
    return () => clearTimeout(timer);
    // deps 는 fetchCourse 하나다. 지연 시간은 이제 ref 로 판단하므로(렌더 값이 아니다)
    // 억제할 exhaustive-deps 경고가 없다 — 예전에는 hasLoadedOnce 를 읽느라 필요했다.
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
    markUserReplan();
    setSelectedTypes((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const markUserReplan = () => {
    userReplanRef.current = true;
  };

  /** 같은 가게가 다른 자리에 고정돼 있으면 그 자리를 비운다.
   *
   * 서버는 한 가게가 두 자리에 고정되면 **두 자리를 모두** 죽인다(그 자리의 후보에서 서로를
   * 빼내기 때문이다). 화면이 그 입력을 만들 수 있으면 안 된다 — 고정은 '옮기는' 것이지
   * '겹치는' 것이 아니다. */
  const withoutDuplicate = (pins: Record<string, string>, key: string, facilityId: string) => {
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(pins)) {
      if (k !== key && v === facilityId) continue; // 다른 자리의 같은 가게는 놓아 준다
      next[k] = v;
    }
    next[key] = facilityId;
    return next;
  };

  /** 자리 번호로 고정을 푼다(고정이 실패해 StopRow 가 사라진 자리에서 쓴다). */
  const unpinSlot = (slotIdx: number) => {
    const key = renderedSlotKeys[slotIdx];
    if (!key) return;
    markUserReplan();
    setPins((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  /** 이 자리를 고정하거나 푼다. */
  const togglePin = (slotIdx: number, facilityId: string) => {
    const key = renderedSlotKeys[slotIdx];
    if (!key) return;
    markUserReplan();
    setPins((prev) => {
      if (prev[key] === facilityId) {
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return withoutDuplicate(prev, key, facilityId);
    });
  };

  /** 대안으로 갈아끼우기 = **그 자리에 고정을 꽂고 다시 짜는 것**이다.
   *
   * 화면에서 카드만 바꿔치기하면 뒤 정류지의 도착 시각·예상 혼잡이 낡은 값이 된다. 출발점과
   * 출발 시각이 달라졌는데 숫자를 그대로 두면 그 순간 화면이 거짓말을 시작한다. */
  const swapTo = (slotIdx: number, facilityId: string) => {
    const key = renderedSlotKeys[slotIdx];
    if (!key) return;
    markUserReplan();
    setPins((prev) => withoutDuplicate(prev, key, facilityId));
  };

  const addToSequence = (type: string) => {
    markUserReplan();
    setSequence((prev) => {
      if (prev.length >= MAX_SEQUENCE) return prev;
      const uid = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      return [...prev, { uid, type }];
    });
  };
  const removeFromSequence = (uid: string) => {
    markUserReplan();
    setSequence((prev) => prev.filter((s) => s.uid !== uid));
    // 칸이 사라지면 그 칸의 고정도 같이 사라진다. (요청을 만들 때 모르는 키는 어차피 걸러지지만,
    // 상태에 남겨 두면 같은 uid 가 다시 생겼을 때 되살아난 것처럼 보인다.)
    setPins((prev) => {
      if (!(uid in prev)) return prev;
      const next = { ...prev };
      delete next[uid];
      return next;
    });
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
    // 혼잡 예측이 없는 정류지가 있어도 공유한다. 예전에는 하나라도 null 이면 undefined 를 돌려
    // ShareButton 이 맨 페이지 URL 로 폴백했는데, 버튼은 그대로 보이는 채 **코스가 빠진 링크**가
    // 조용히 공유됐다. 받는 사람은 자기 코스를 새로 받을 뿐이라 아무도 어긋난 줄 모른다.
    // 게다가 모델이 미학습이면(프로덕션 현재 상태 — /predict/model-info trained=false)
    // 모든 정류지가 null 이라 '가끔' 이 아니라 '항상' 그렇다.
    // 미상은 '-' 로 실어 보내고 받는 쪽이 혼잡 배지를 생략한다(courseShare.ts 포맷 주석 참조).
    if (typeof window === "undefined") return undefined;
    // **공유받은 코스를 다시 공유할 때는 원본 링크를 그대로 넘긴다.**
    //
    // sharedStops 의 도착 오프셋은 경과 시간만큼 이미 깎여 있고(fetchSharedStops), 혼잡 수치는
    // 원래 도착 시각의 예측값 그대로다. 그걸 다시 인코딩하면 encodeStops 가 **새 공유 시각**을
    // 찍어서, 3시간 전 링크를 받은 사람이 재공유하면 다음 사람에게는 정류지가 전부 '지금 바로
    // 도착' 인 존재할 수 없는 일정이 간다. 게다가 새 시각 탓에 '{n}분 전 공유됨' 배너까지
    // 사라져 맥락을 주던 유일한 장치가 없어진다 — courseShare.ts 가 공유 시각을 싣는 이유가
    // 정확히 그 왜곡을 막으려는 것인데, 전달 경로가 그 왜곡을 만들고 있었다.
    if (isShareMode) return shareParam ? window.location.href : undefined;
    if (activeStops.length === 0) return undefined;
    const encoded = encodeStops(
      activeStops.map((s) => ({
        id: s.facility.id,
        offsetMin: s.arrivalOffsetMin,
        congestion: s.predictedCongestion,
      }))
    );
    return `${window.location.origin}/course?s=${encodeURIComponent(encoded)}&ref=share`;
  }, [activeStops, isShareMode, shareParam]);

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

              {/* 고정을 비우는 마지막 탈출구.
                  '순서 초기화'(setPins({}))는 sequence 가 있을 때만 그려지므로, 자동 모드에서
                  고정을 걸어 두면 그것을 지울 경로가 화면에 하나도 없었다. 고정이 실패한
                  자리에는 해제 버튼이 붙지만(DroppedSlotRow), 그 자리조차 안 나오는 경우
                  (후보 0곳 등)를 위해 항상 닿을 수 있는 자리를 둔다. */}
              {!isShareMode && sequence.length === 0 && Object.keys(pins).length > 0 && (
                <button
                  type="button"
                  onClick={() => { markUserReplan(); setPins({}); }}
                  className="self-start rounded-full border border-line bg-white px-3 py-1.5 text-[11px] font-bold text-muk-soft hover:border-gold/40 hover:text-gold-deep transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/50"
                >
                  📌 {t('course.unpinAll')}
                </button>
              )}

              {/* 순서 지정 피커 — 공유 모드(읽기 전용)에서는 숨김(간섭 방지). */}
              {!isShareMode && (
                <OrderPicker
                  sequence={sequence}
                  onAdd={addToSequence}
                  onRemove={removeFromSequence}
                  onReorder={(next) => { markUserReplan(); setSequence(next); }}
                  onReset={() => { markUserReplan(); setSequence([]); setPins({}); }}
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
                  <EmptyState outcomes={isShareMode ? [] : slotOutcomes} />
                ) : (
                  <div className="space-y-4">
                    <ViewToggle mode={viewMode} onChange={setViewMode} />
                    {viewMode === "gantt" ? (
                      <CourseGantt stops={activeStops} />
                    ) : (
                      <StopRows
                        stops={activeStops}
                        readOnly={isShareMode}
                        outcomes={isShareMode ? [] : slotOutcomes}
                        pins={pins}
                        slotKeys={renderedSlotKeys}
                        onTogglePin={togglePin}
                        onSwap={swapTo}
                        onUnpin={unpinSlot}
                      />
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
          const cong = s.predictedCongestion == null ? { key: 'moderate', cls: 'bg-hanji-deep border-line text-muk-soft' } : congestion(s.predictedCongestion);
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
                    {s.predictedCongestion == null ? '—' : `${Math.round(s.predictedCongestion * 100)}%`}
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
/** 사용자가 짠 자리 번호(1부터)를 찾는다.
 *
 * stop.order 는 **채운 것만으로** 다시 매겨진 번호라 요청한 자리와 다를 수 있다(2번이 비면
 * 3번이 stop.order 2 가 된다). 고정·갈아끼우기는 요청한 자리에 걸어야 하므로 여기서 되돌린다.
 * 자리 결과가 없으면(구 API 폴백) 둘이 같다고 볼 수밖에 없다 — 그때는 고정도 쓰지 않는다. */
function requestedSlotIndex(stop: CourseStop, outcomes: SlotOutcome[]): number {
  const hit = outcomes.find((o) => o.status === 'filled' && o.facilityId === stop.facility.id);
  return (hit ? hit.order : stop.order) - 1;
}

function StopRows({
  stops,
  readOnly = false,
  outcomes = [],
  pins = {},
  slotKeys = [],
  onTogglePin,
  onSwap,
  onUnpin,
}: {
  stops: CourseStop[];
  readOnly?: boolean;
  outcomes?: SlotOutcome[];
  pins?: Record<string, string>;
  slotKeys?: string[];
  onTogglePin?: (slotIdx: number, facilityId: string) => void;
  onSwap?: (slotIdx: number, facilityId: string) => void;
  onUnpin?: (slotIdx: number) => void;
}) {
  // 못 채운 자리를 **요청한 순서 그대로** 사이사이에 끼워 그린다. 목록에서 사라지게 두면
  // 사용자는 자리가 빠졌다는 것만 알고 이유를 영영 모른다(응답 order 는 다시 매겨진다).
  // 자리 결과가 없으면 구 API 응답이다(/plan 이 아직 배포되지 않은 창). 그때는 고정·갈아끼우기를
  // **그리지 않는다** — 버튼은 보이는데 서버가 pins 를 모르고 조용히 무시하면, 눌러도 아무 일도
  // 일어나지 않는 조작을 준 셈이 된다.
  const replanSupported = outcomes.length > 0;
  const dropped = outcomes.filter((o) => o.status !== 'filled');
  const rows = [
    ...stops.map((stop) => ({ order: requestedSlotIndex(stop, outcomes) + 1, stop, outcome: null as SlotOutcome | null })),
    ...dropped.map((outcome) => ({ order: outcome.order, stop: null as CourseStop | null, outcome })),
  ].sort((a, b) => a.order - b.order);

  return (
    <div className="-mx-4 md:-mx-6 divide-y divide-line">
      {rows.map((row) =>
        row.stop ? (
          <StopRow
            key={row.stop.facility.id}
            stop={row.stop}
            readOnly={readOnly}
            slotIdx={
              // 매핑할 자리 키가 없으면 아예 넘기지 않는다 — 넘기면 버튼은 활성인데
              // togglePin 의 `if (!key) return` 에 걸려 아무 일도 안 일어난다.
              replanSupported && row.order - 1 < slotKeys.length ? row.order - 1 : undefined
            }
            pinned={pins[slotKeys[row.order - 1]] === row.stop.facility.id}
            onTogglePin={onTogglePin}
            onSwap={onSwap}
          />
        ) : (
          <DroppedSlotRow
            key={`slot-${row.order}`}
            outcome={row.outcome as SlotOutcome}
            // 고정이 실패한 자리에서 **고정 해제 수단이 사라지면 안 된다.** 📌 버튼은
            // StopRow 안에만 있어서, 고정한 가게가 자격에 걸리는 순간 그 자리는
            // DroppedSlotRow 가 되고 해제할 방법이 화면에서 없어졌다. pins 는 상태로 남아
            // 매 요청에 다시 실려 나가므로 같은 이유로 계속 비었다 — 새로고침 말고는 탈출구가
            // 없었고, 밤에 '도착 시각 영업' 으로 떨어진 경우는 되돌릴 조건조차 없다.
            onUnpin={
              replanSupported && row.outcome?.pinned && row.order - 1 < slotKeys.length && !readOnly
                ? () => onUnpin?.(row.order - 1)
                : undefined
            }
          />
        ),
      )}
    </div>
  );
}

// 채우지 못한 자리 — 사라지게 두지 않고 **이유를 달아** 자리를 지킨다.
// 이유는 서버가 준 코드를 그대로 옮긴다. 개수 차이로 추측한 문장을 쓰면 그건 지어낸 값이다.
const SLOT_REASON_KEY: Record<string, string> = {
  no_candidate_of_type: 'course.slotNoCandidate',
  closed_at_arrival: 'course.slotClosedAtArrival',
  late_night_unconfirmed: 'course.slotLateNight',
  over_time_budget: 'course.slotOverTimeBudget',
  pin_unavailable: 'course.slotPinUnavailable',
};

/** 그 자리의 사유 문구 키.
 *
 * `slotNoCandidate` 는 "이 근처에 조건에 맞는 {type}이(가) 없어요" 라 **종류 이름이 있어야**
 * 말이 된다. 자동 모드에는 요청한 종류가 없어서(requestedType=null) 예전에는 빈 문자열이
 * 들어가 "조건에 맞는 이(가) 없어요" 라는 깨진 문장이 나갔다 — 자동 모드에서는 **항상** 그랬다.
 * 종류가 없을 때는 종류를 말하지 않는 문장을 쓴다. */
function slotReasonKey(outcome: SlotOutcome): string | undefined {
  if (outcome.status === 'no_candidate_of_type' && !outcome.requestedType) {
    return 'course.slotNoCandidateAny';
  }
  return SLOT_REASON_KEY[outcome.status];
}

function DroppedSlotRow({
  outcome,
  onUnpin,
}: {
  outcome: SlotOutcome;
  onUnpin?: () => void;
}) {
  const t = useT();
  const reasonKey = slotReasonKey(outcome);
  return (
    <div className="px-4 md:px-6 py-4 bg-hanji-deep/30">
      <div className="flex items-start gap-3">
        <span
          className="shrink-0 flex items-center justify-center w-9 h-9 rounded-full border border-dashed border-line text-base text-muk-soft"
          aria-hidden
        >
          {outcome.requestedType ? typeEmoji(outcome.requestedType) : '·'}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-muk-soft">
            {t('course.slotDropped', { n: outcome.order })}
          </p>
          {reasonKey && (
            <p className="mt-0.5 text-[11px] text-muk-soft">
              {t(reasonKey, {
                type: outcome.requestedType ? t(`category.${outcome.requestedType}`) : '',
              })}
            </p>
          )}
          <p className="mt-1 text-[10px] text-muk-soft/80">{t('course.slotHint')}</p>
          {onUnpin && (
            <button
              type="button"
              onClick={onUnpin}
              className="mt-2 inline-flex items-center gap-1 rounded-full border border-line bg-white px-2.5 py-1 text-[11px] font-bold text-muk-soft hover:border-gold/40 hover:text-gold-deep transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/50"
            >
              📌 {t('course.unpin')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function StopRow({
  stop,
  readOnly = false,
  slotIdx,
  pinned = false,
  onTogglePin,
  onSwap,
}: {
  stop: CourseStop;
  readOnly?: boolean;
  slotIdx?: number;
  pinned?: boolean;
  onTogglePin?: (slotIdx: number, facilityId: string) => void;
  onSwap?: (slotIdx: number, facilityId: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [altsOpen, setAltsOpen] = useState(false);
  const alternatives = stop.alternatives ?? [];
  // 재계획 조작은 공유 모드(읽기 전용)에도, 자리 번호를 모를 때도 그리지 않는다.
  const canReplan = !readOnly && slotIdx !== undefined && slotIdx >= 0;
  const altsId = `course-alts-${stop.facility.id}`;
  const cong = stop.predictedCongestion == null ? null : congestion(stop.predictedCongestion);
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
              {pinned && (
                <span className="ml-1.5 align-middle px-1.5 py-0.5 rounded-md bg-gold/15 border border-gold/30 text-[9px] font-bold text-gold-deep">
                  📌 {t('course.pinnedBadge')}
                </span>
              )}
            </h3>
            {cong && stop.predictedCongestion != null && <span className={`shrink-0 px-2 py-0.5 rounded-lg text-[10px] font-bold border ${cong.cls}`}>
              {t(`congestion.${cong.key}`)} {Math.round(stop.predictedCongestion * 100)}%
            </span>}
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

          {canReplan && (alternatives.length > 0 || pinned) && (
            <div className="flex items-center gap-2 mt-2">
              {alternatives.length > 0 && (
                <button
                  type="button"
                  onClick={() => setAltsOpen((v) => !v)}
                  aria-expanded={altsOpen}
                  aria-controls={altsId}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-line bg-white text-[11px] font-bold text-muk-soft hover:border-gold/40 hover:text-gold-deep transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/50"
                >
                  {altsOpen ? t('course.altsHide') : t('course.altsToggle', { n: alternatives.length })}
                  <ChevronDown size={12} className={`transition-transform ${altsOpen ? 'rotate-180' : ''}`} aria-hidden />
                </button>
              )}
              <button
                type="button"
                onClick={() => onTogglePin?.(slotIdx as number, stop.facility.id)}
                aria-pressed={pinned}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-[11px] font-bold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/50 ${
                  pinned
                    ? 'border-gold/40 bg-gold/15 text-gold-deep'
                    : 'border-line bg-white text-muk-soft hover:border-gold/40 hover:text-gold-deep'
                }`}
              >
                📌 {pinned ? t('course.pinOff') : t('course.pinOn')}
              </button>
            </div>
          )}

          {/* 대안 목록. 서버가 그 자리의 실제 출발점·누적 도착 시각에서 이미 채점해 둔 값이라
              도착 시각·예상 혼잡을 그대로 보여 준다(따로 계산하거나 지어내지 않는다). */}
          {canReplan && altsOpen && alternatives.length > 0 && (
            <div id={altsId} className="mt-2 rounded-xl border border-line bg-hanji-deep/40 divide-y divide-line/70">
              {alternatives.map((alt) => {
                const altCong = alt.predictedCongestion == null ? null : congestion(alt.predictedCongestion);
                return (
                  <div key={alt.facility.id} className="flex items-center gap-2 px-3 py-2">
                    <span aria-hidden className="shrink-0 text-sm">{typeEmoji(alt.facility.type)}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[12px] font-bold text-muk truncate">{alt.facility.name}</p>
                      <p className="text-[10px] text-muk-soft">
                        🕒 {arrivalText(alt.arrivalOffsetMin, t)}
                        {altCong && alt.predictedCongestion != null && (
                          <> · {t(`congestion.${altCong.key}`)} {Math.round(alt.predictedCongestion * 100)}%</>
                        )}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => onSwap?.(slotIdx as number, alt.facility.id)}
                      className="shrink-0 px-2.5 py-1 rounded-full border border-gold/30 bg-gold/10 text-[10px] font-bold text-gold-deep hover:bg-gold/20 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/50"
                    >
                      {t('course.altsPick')}
                    </button>
                  </div>
                );
              })}
              <p className="px-3 py-2 text-[10px] leading-snug text-muk-soft">{t('course.altsNote')}</p>
            </div>
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

/** 코스가 하나도 안 나왔을 때.
 *
 * 서버는 자리마다 **왜** 비었는지 코드로 알려 준다(slot_outcomes). 예전에는 이 화면이
 * 그걸 받고도 쓰지 않아, 밤에 심야 규칙으로 후보가 전부 빠져도 사용자는 "추천할 코스를
 * 찾지 못했어요" 한 줄만 봤다 — 조건을 바꿔야 하는지, 기다려야 하는지, 앱이 고장인지
 * 구분할 방법이 없었다. 사유가 있으면 그것부터 말한다. */
function EmptyState({ outcomes = [] }: { outcomes?: SlotOutcome[] }) {
  const t = useT();
  // 같은 사유가 자리마다 반복되므로(대개 전 자리가 같은 이유로 빈다) 한 번씩만 보여 준다.
  // 사유 문구는 종류 이름을 품을 수 있으므로(자리마다 다르다) 키가 아니라 **완성된 문장**으로
  // 모아 중복을 없앤다. 키로만 묶으면 '식당이 없어요' 와 '카페가 없어요' 가 하나로 뭉개진다.
  const reasons = [...new Set(
    outcomes
      .filter((o) => o.status !== 'filled')
      .map((o) => {
        const key = slotReasonKey(o);
        if (!key) return null;
        return t(key, { type: o.requestedType ? t(`category.${o.requestedType}`) : '' });
      })
      .filter((line): line is string => Boolean(line)),
  )];
  return (
    <div className="bg-white rounded-2xl border border-line shadow-[0_2px_14px_rgba(43,35,32,0.06)] p-8 text-center space-y-2">
      <div className="text-3xl">🗺️</div>
      <p className="text-sm font-semibold text-muk">{t('course.emptyTitle')}</p>
      {reasons.length > 0 ? (
        <div className="space-y-1">
          <p className="text-[11px] font-semibold text-muk-soft">{t('course.emptyReasonsTitle')}</p>
          <ul className="space-y-0.5">
            {reasons.map((line) => (
              <li key={line} className="text-xs text-muk leading-relaxed">
                {line}
              </li>
            ))}
          </ul>
          <p className="pt-1 text-[11px] text-muk-soft leading-relaxed">{t('course.slotHint')}</p>
        </div>
      ) : (
        <p className="text-xs text-muk-soft leading-relaxed">{t('course.emptyBody')}</p>
      )}
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
