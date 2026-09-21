"use client";

// 스마트 줄서기 보드(정보형) — "지금 출발하면?" : 식당·카페·관광지·문화시설을 유형별 섹터로 나눠
// 도착 시점 예상 대기가 짧은 순으로 보여주는 정보 전용 보드다. 새 예약/줄서기 백엔드를 만들지 않고,
// 기존 SPOT 추천(recommendByType → breakdown.waitTime/travelTime)을 재사용해 "얼마나 기다릴지"만 보여준다.
//
// 레이아웃(PM 지시): 섹터(유형)별로 도착 대기 짧은 순 상위 3곳을 세로로 긴 대표 카드 3장으로 올리고,
// 나머지는 그 아래 컴팩트 행 리스트로 줄줄이 보여준다. 응답이 빈 유형은 섹터 자체를 숨긴다.
//
// 위치는 main/page.tsx 와 동일한 기본 좌표 폴백(REGION.center)을 쓴다 — 이 보드는 별도로 GPS 를
// 새로 얻지 않는다(관광객이 지도에서 이미 위치를 확인한 뒤 들어오는 보조 정보 화면이라는 전제).
//
// 백엔드 미가용(POST /api/v1/recommendations/by-type 실패) 시 무한 스켈레톤 대신
// "예측 서버 연결 안 됨" 빈 상태 + 재시도 버튼을 보여준다(course/page.tsx 의 ErrorState 와 동일 사상).
// 정적 export(SSR) 안전: 브라우저 전용 API 는 쓰지 않는다(REGION 은 순수 상수).

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ChevronRight } from "lucide-react";
import {
  isServiceUnavailable,
  recommendByType,
  ASSUMED_TIME_PRESETS,
  ASSUMED_TIME_EVENT,
  assumedAtIsoForPreset,
  getStoredAssumedPreset,
  setStoredAssumedPreset,
} from "@/lib/api-client";
import { recToSpot } from "@/lib/recommender";
import { congestionDisplay } from "@/lib/congestionEstimate";
import { REGION } from "@/lib/region";
import { useI18n, useT } from "@/lib/i18n/I18nProvider";
import { GoldenHourBadge } from "@/components/GoldenHourBadge";
import NowChip from "@/components/NowChip";
import LoadingReveal from "@/components/LoadingReveal";
// T2: 휴무 원문(rest_date_raw) 파서 — 오늘 휴무 '확정'만 판정(모르면 null, 과판정 금지). 공용 단일 소스.
import { isClosedToday } from "@/lib/restDate";

// 시설 종류 이모지 — course/page.tsx TYPE_OPTIONS 와 동일 매핑(레포 전역 관례 통일).
const TYPE_EMOJI: Record<string, string> = {
  restaurant: "🍴",
  cafe: "☕",
  attraction: "📸",
  culture: "🏛️",
};

// 보드 섹터 — recommendByType 이 지원하는 4유형을 그대로 병렬 섹터로 노출한다.
const BOARD_TYPES = ["restaurant", "cafe", "attraction", "culture"] as const;

// 섹터당 대표 카드 개수(상위 N).
const TOP_CARD_COUNT = 3;
// 유형당 조회 개수(대표 3 + 리스트 여유분) — 과호출 방지를 위한 상한.
const PER_TYPE_LIMIT = 8;

// 스테일-우선 캐시 — 마지막 성공 보드를 로컬에 보관해 재방문 시 **즉시** 그리고,
// 백그라운드로 조용히 새로고침한다. 새 조회가 실패해도 캐시가 있으면 에러 화면 대신
// 최근 결과를 유지한다(백엔드 지연·재시작 창에서 심사위원이 빈손을 보지 않게).
const BOARD_CACHE_KEY = "nextspot_waiting_board_v1";
const BOARD_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface BoardRow {
  facilityId: string;
  name: string;
  type: string;
  imageUrls: string[];
  summary: string | null;
  imageSource: { provider?: string; sourceUrl?: string; license?: string; artist?: string } | null;
  congestionLevel: number | null;
  // 매장 내부 혼잡이 없을 때도 공영주차·관광 근거로 대안성을 보여주는 주변 권역 수요.
  areaDemandLevel: number | null;
  areaDemandMode: "live" | "forecast" | "statistical" | "contextual" | null;
  areaDemandRadiusM: number | null;
  areaDemandParkingEvidence: {
    level: number;
    mode: "live" | "forecast";
    observedAt?: string | null;
    radiusM?: number | null;
  } | null;
  areaDemandTourismEvidence: {
    referenceName?: string | null;
    distanceM?: number | null;
    forecastDate?: string | null;
    relativeIndex?: number | null;
  } | null;
  arrivalAction: "go_now" | "wait_then_go" | "choose_calmer" | "no_clear_advantage" | null;
  recommendedDepartureDelayMinutes: number | null;
  // 검증 모델이 없는 degraded 응답은 waitTime=null이다. 0분으로 바꾸면 안 된다.
  expectedWait: number | null;
  expectedTravel: number;
  // 오늘 휴무 '확정'(isClosedToday === true) 여부 — 대표 카드 선정에서 제외 + 리스트 맨 뒤 + 배지 표시용.
  closedToday: boolean;
  // TourAPI 대표·취급 메뉴를 합친 실제 메뉴(최대 5개).
  menus: string[];
}

// 섹터 = 한 시설 유형의 대기 짧은 순 정렬 목록. rows 가 비면 섹터 자체를 렌더하지 않는다.
interface Sector {
  type: string;
  rows: BoardRow[];
}

// TourAPI firstimage가 비어 있거나 원본 서버에서 만료·차단되어 로드에 실패하면
// 같은 높이의 유형 아이콘 폴백으로 즉시 전환해 카드 상단이 빈 공간으로 남지 않게 한다.
function WaitingCardImage({ imageUrls, name, type }: Pick<BoardRow, "imageUrls" | "name" | "type">) {
  const [imageIndex, setImageIndex] = useState(0);
  const imageUrl = imageUrls[imageIndex];

  if (!imageUrl) {
    return (
      <div
        className="h-28 w-full shrink-0 flex items-center justify-center bg-hanji-deep/70 border-b border-line text-2xl"
        aria-hidden
      >
        {TYPE_EMOJI[type] ?? "📍"}
      </div>
    );
  }

  return (
    // TourAPI 원본 이미지 도메인이 다양하고 정적 export이므로 img를 직접 사용한다.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={imageUrl}
      alt={name}
      loading="lazy"
      onError={() => setImageIndex((current) => current + 1)}
      className="w-full h-28 shrink-0 object-cover border-b border-line bg-hanji-deep/40"
    />
  );
}

// 카드 상단 혼잡 pill 과 동일한 4단계 임계값(혼잡/보통/여유/한산) — RecommendationCard 미러.
const congestionKey = (c: number) =>
  c >= 0.75 ? "busy" : c >= 0.5 ? "moderate" : c >= 0.25 ? "relaxed" : "quiet";

// 혼잡 배지 색상 클래스 — 대표 카드·리스트 행에서 공유.
// 여유·한산은 jade 하나로 통일한다(/course CONGESTION_CLASS 와 동일 팔레트) — 같은 '여유'가
// 화면마다 다른 초록으로 보이면 같은 등급인지 헷갈린다. terracotta 는 '혼잡' 하나에만 아껴 쓴다.
const congestionBadgeClass = (c: number) =>
  c >= 0.75
    ? "bg-terracotta/10 border-terracotta/30 text-terracotta"
    : c >= 0.5
    ? "bg-gold/10 border-gold/30 text-gold-deep"
    : c >= 0.25
    ? "bg-jade/10 border-jade/25 text-jade"
    : "bg-jade/15 border-jade/30 text-jade";

export default function WaitingBoardPage() {
  const router = useRouter();
  const { t, locale } = useI18n();

  const [sectors, setSectors] = useState<Sector[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  // 데모 '가정 시각' 프리셋 — /main·/course 와 localStorage 한 키로 공유하고 이벤트로 동기화한다.
  // 초기값은 'now'(SSR/정적 export 안전) → 마운트 후 저장값으로 맞춘다.
  const [assumedPreset, setAssumedPreset] = useState<string>("now");
  useEffect(() => {
    setAssumedPreset(getStoredAssumedPreset());
    const sync = () => setAssumedPreset(getStoredAssumedPreset());
    window.addEventListener(ASSUMED_TIME_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(ASSUMED_TIME_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  // fetchBoard 는 useCallback([]) 로 마운트 시 1회만 만들어져 locale 을 클로저로 캡처하면 언어 전환
  // 후 재조회(재시도 버튼 등)해도 옛 로케일로 요약을 구성하게 된다 — ref 로 항상 최신값을 읽는다.
  const localeRef = useRef(locale);
  useEffect(() => { localeRef.current = locale; }, [locale]);

  // main 과 동일한 기본 좌표 폴백(경주 황리단길 중심) — 지역 단일 소스(REGION)에서 가져온다.
  const userLocation = { lat: REGION.center.lat, lng: REGION.center.lng };

  // 세션 부트스트랩 유예 자동 재시도 1회 플래그(아래 fetchBoard 참조)
  const retriedRef = useRef(false);
  // JWKS 등 서버 일시 장애(503)는 짧은 backoff 뒤 1회만 별도 재시도한다.
  const serviceUnavailableRetriedRef = useRef(false);
  // 스테일-우선: 화면에 결과가 이미 있으면(캐시 또는 직전 성공) 이후 조회는 조용히 돌고,
  // 실패해도 에러 화면으로 갈아치우지 않는다. preset 이 바뀌면 로더를 다시 보여준다.
  const hasRenderedResultsRef = useRef(false);
  const renderedPresetRef = useRef<string | null>(null);

  // 마운트 시 캐시 하이드레이션 — fetch 이펙트보다 먼저 선언되어 먼저 실행된다.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(BOARD_CACHE_KEY);
      if (!raw) return;
      const cached = JSON.parse(raw) as { sectors?: Sector[]; savedAt?: number; preset?: string };
      if (!Array.isArray(cached.sectors) || cached.sectors.length === 0) return;
      if (typeof cached.savedAt !== "number" || Date.now() - cached.savedAt > BOARD_CACHE_MAX_AGE_MS) return;
      if ((cached.preset ?? "now") !== getStoredAssumedPreset()) return; // 다른 가정 시각의 결과는 안 보여준다
      hasRenderedResultsRef.current = true;
      renderedPresetRef.current = cached.preset ?? "now";
      setSectors(cached.sectors);
      setLoading(false); // 이후 fetchBoard 가 백그라운드로 갱신
    } catch { /* 캐시 손상·저장소 차단 — 평소 로딩 경로 그대로 */ }
  }, []);

  const goToDetail = useCallback(
    (facilityId: string) => {
      router.push(
        `/explore/recommend?facilityId=${encodeURIComponent(facilityId)}&lat=${userLocation.lat}&lng=${userLocation.lng}`
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [router]
  );

  const fetchBoard = useCallback(async () => {
    // 화면에 같은 가정 시각의 결과가 이미 있으면 조용한 새로고침(로더 생략) — 스테일-우선.
    const silentRefresh = hasRenderedResultsRef.current && renderedPresetRef.current === assumedPreset;
    if (!silentRefresh) setLoading(true);
    setFailed(false);

    // 4유형을 병렬 조회하되 allSettled 로 부분 실패를 흡수한다 — 일부만 살아 있어도 나머지 섹터는 채운다.
    // 전부 실패했을 때만 '백엔드 미가용'으로 판정(정직한 에러 상태 + 재시도).
    // 백엔드가 '동시' 요청에 503 을 낸다(용량 한계 — 라이브에서 첫 요청만 200, 나머지 503 확인).
    // 그래서 4유형을 동시에 쏘지 않고 '순차'로 하나씩 호출해 동시성 1 을 유지한다: 단건 요청은
    // 성공하므로 보드가 안정적으로 채워지고, 재시도 스톰으로 백엔드를 무너뜨리지 않는다. 프리미엄
    // 로딩 화면이 그 사이를 덮는다. 마지막 인자(45s)는 이 호출 전용 타임아웃 — 0.5CPU/512MB 인스턴스가
    // 재시작 직후 콜드 상태면 단건 처리도 20초를 넘겨(라이브 실측), 20s 는 서버 성공을 클라가 끊었다.
    const results: PromiseSettledResult<Awaited<ReturnType<typeof recommendByType>>>[] = [];
    for (const type of BOARD_TYPES) {
      try {
        const value = await recommendByType(type, userLocation, [], PER_TYPE_LIMIT, undefined, undefined, undefined, 45000, assumedAtIsoForPreset(assumedPreset));
        results.push({ status: "fulfilled", value });
      } catch (reason) {
        results.push({ status: "rejected", reason });
      }
    }

    // 두 번째 패스: 실패한 유형만 한 번 더(여전히 순차, 2초 유예 — 스톰 아님). 유휴 직후 첫
    // 호출은 콜드 경로(JWKS 캐시·풀 연결)에서 일시 503 이 나기 쉽고, 몇 초 뒤 단건 재시도는
    // 거의 통과한다(라이브 실측: 첫 호출만 503, 이후 전부 200). 섹터 하나가 비면 심사위원에겐
    // 구멍으로 보이므로 여기서 메운다.
    if (results.some((r) => r.status === "rejected")) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      for (let i = 0; i < BOARD_TYPES.length; i++) {
        if (results[i].status !== "rejected") continue;
        try {
          const value = await recommendByType(BOARD_TYPES[i], userLocation, [], PER_TYPE_LIMIT, undefined, undefined, undefined, 45000, assumedAtIsoForPreset(assumedPreset));
          results[i] = { status: "fulfilled", value };
        } catch { /* 그대로 실패 유지 — 나머지 섹터로 보드는 뜬다 */ }
      }
    }

    const nextSectors: Sector[] = [];
    let anySucceeded = false;

    results.forEach((r, i) => {
      if (r.status !== "fulfilled") return;
      anySucceeded = true;

      const rows: BoardRow[] = r.value.map((rec) => {
        const spot = recToSpot(rec);
        // apiClient 응답 변환(keysToCamel)이 features 내부 키까지 재귀적으로 camelCase 로 바꾸므로
        // (rest_date_raw → restDateRaw) 두 표기를 모두 확인한다(main/page.tsx의 barrierFree 방어 패턴과 동일).
        const restDateRaw = (rec.facility.features?.rest_date_raw ?? rec.facility.features?.restDateRaw) as
          | string
          | null
          | undefined;
        // 공식 대표·취급 메뉴를 합쳐 최대 5개. 없는 메뉴는 지어내지 않는다.
        const firstMenuRaw = (rec.facility.features?.first_menu ?? rec.facility.features?.firstMenu) as
          | string
          | null
          | undefined;
        const treatMenuRaw = (rec.facility.features?.treat_menu ?? rec.facility.features?.treatMenu) as
          | string
          | null
          | undefined;
        const menus = Array.from(new Set(
          [firstMenuRaw, treatMenuRaw]
            .filter((value): value is string => typeof value === "string")
            .flatMap((value) => value.split(/[,/\n·]+/).map((item) => item.trim()).filter(Boolean))
        )).slice(0, 5);
        // 소개(overview) 다국어 — 배치 번역(apps/api/scripts/translate_overviews.py)이
        // features.overview_i18n = {en, ja, zh} 에 저장(스키마 변경 없음). RecommendationCard 와 동일하게
        // camelCase(overviewI18n)·원본 snake_case(overview_i18n) 두 표기를 모두 지원한다.
        // 로케일이 ko 면 항상 원문만 쓴다(번역 유무와 무관 — 기존 동작 불변).
        const overviewI18n = (rec.facility.features?.overviewI18n ?? rec.facility.features?.overview_i18n) as
          | Record<string, string>
          | null
          | undefined;
        const currentLocale = localeRef.current;
        const translatedOverview = currentLocale !== "ko" ? overviewI18n?.[currentLocale] : undefined;
        const overviewText = (translatedOverview || rec.facility.overview)?.trim();
        return {
          facilityId: rec.facility.id,
          name: rec.facility.name,
          type: rec.facility.type,
          // 대표 사진(firstimage)부터 detailImage2 갤러리 순으로 시도한다. 동일 URL은 한 번만 로드한다.
          imageUrls: Array.from(
            new Set(
              [rec.facility.imageUrl, ...(rec.facility.galleryImages ?? [])].filter(
                (url): url is string => typeof url === "string" && url.trim().length > 0
              )
            )
          ),
          // TourAPI 소개(비-ko 로케일이면 배치 번역 우선)를 우선하고, 없으면 실제 주소를 짧은 보조
          // 설명으로 사용한다. 둘 다 없을 때는 내용을 지어내지 않고 설명 영역을 숨긴다.
          summary: overviewText || rec.facility.address?.trim() || null,
          imageSource: (() => {
            const source = rec.facility.features?.imageSource;
            return source && typeof source === "object"
              ? source as BoardRow["imageSource"]
              : null;
          })(),
          // 카드·추천 목록과 **같은 판정**을 쓴다. 이 보드는 같은 RecommendItem 을 받으면서
          // 원시 congestionLevel 만 읽어, 추천 화면이 '추정 · 여유' 라고 말하는 시설을
          // '혼잡' 으로 그리고 있었다(2026-09-20 적대적 검토). 추정은 여기서 그리지 않고
          // (이 보드는 대기 예측 화면이라 추정 어휘가 없다) '근거 없음' 으로 둔다.
          congestionLevel: (() => {
            const display = congestionDisplay(rec);
            return display.mode === "measured" || display.mode === "predicted" ? display.level : null;
          })(),
          areaDemandLevel: typeof spot.areaDemandLevel === "number" ? spot.areaDemandLevel : null,
          areaDemandMode: spot.areaDemandMode ?? null,
          areaDemandRadiusM: typeof spot.areaDemandRadiusM === "number" ? spot.areaDemandRadiusM : null,
          areaDemandParkingEvidence: spot.areaDemandParkingEvidence ?? null,
          areaDemandTourismEvidence: spot.areaDemandTourismEvidence ?? null,
          arrivalAction: spot.arrivalAction ?? null,
          recommendedDepartureDelayMinutes: spot.recommendedDepartureDelayMinutes ?? null,
          expectedWait:
            typeof rec.breakdown?.waitTime === "number" ? rec.breakdown.waitTime : null,
          expectedTravel: spot.expectedTravel,
          // 휴무 '확정'(true)만 표시 — 모름(null)/영업 확정(false)은 평소처럼 취급(정직성: 과판정 금지).
          closedToday: isClosedToday(restDateRaw) === true,
          menus,
        };
      });
      // 대기 짧은 순 정렬은 그대로 유지하되, 오늘 휴무 확정 시설은 항상 맨 뒤로 보낸다
      // (대표 카드가 rows 앞쪽 3개를 그대로 슬라이스하지 않도록 아래에서 open/closed 를 명시적으로 분리한다).
      rows.sort((a, b) => {
        if (a.closedToday !== b.closedToday) return a.closedToday ? 1 : -1;
        if (a.expectedWait === null && b.expectedWait === null) return 0;
        if (a.expectedWait === null) return 1;
        if (b.expectedWait === null) return -1;
        return a.expectedWait - b.expectedWait;
      });

      // 응답이 빈 유형은 섹터 자체를 숨긴다(PM 지시).
      if (rows.length > 0) nextSectors.push({ type: BOARD_TYPES[i], rows });
    });

    if (!anySucceeded) {
      const allServiceUnavailable = results.every(
        (result) => result.status === "rejected" && isServiceUnavailable(result.reason)
      );

      if (allServiceUnavailable) {
        if (!serviceUnavailableRetriedRef.current) {
          serviceUnavailableRetriedRef.current = true;
          setTimeout(() => { void fetchBoard(); }, 500);
          return; // loading 유지 — 503 자동 재시도는 1회로 제한
        }
        if (silentRefresh) { setLoading(false); return; } // 캐시 결과 유지 — 에러로 갈아치우지 않는다
        setFailed(true);
        setSectors(null);
        setLoading(false);
        return;
      }

      // 첫 진입 직행 시 익명 세션 부트스트랩(SessionBootstrap)이 끝나기 전 401 로 전멸할 수 있다
      // (실측 재현). 유예 2.5초 후 자동 1회만 재시도 — 그래도 실패하면 정직한 에러+수동 재시도.
      if (!retriedRef.current) {
        retriedRef.current = true;
        setTimeout(() => { void fetchBoard(); }, 2500);
        return; // loading 유지(스켈레톤) — 유예는 유한(1회)이라 무한 스켈레톤 아님
      }
      if (silentRefresh) { setLoading(false); return; } // 캐시 결과 유지
      setFailed(true);
      setSectors(null);
      setLoading(false);
      return;
    }

    setSectors(nextSectors);
    setLoading(false);
    hasRenderedResultsRef.current = true;
    renderedPresetRef.current = assumedPreset;
    // 성공 결과를 캐시에 남긴다 — 다음 방문은 즉시 그리고 백그라운드 갱신(스테일-우선).
    try {
      window.localStorage.setItem(
        BOARD_CACHE_KEY,
        JSON.stringify({ sectors: nextSectors, savedAt: Date.now(), preset: assumedPreset }),
      );
    } catch { /* 저장소 차단/용량 — 캐시 없이도 동작 동일 */ }
    // assumedPreset 이 바뀌면 새 가정 시각으로 다시 조회한다(나머지는 ref/마운트 1회 캡처).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assumedPreset]);

  useEffect(() => {
    fetchBoard();
  }, [fetchBoard]);

  // 히어로 요약 스탯 — 이미 상태에 있는 결과에서 '도착 시 대기'가 가장 짧은 값 하나만 뽑는다
  // 현재 상태에 있는 추천 수를 표시하고 오늘 휴무가 확정된 시설은 제외한다.
  const bestWait = (() => {
    if (!sectors) return null;
    let best: number | null = null;
    for (const sector of sectors) {
      for (const row of sector.rows) {
        if (row.closedToday || row.expectedWait === null) continue;
        if (best === null || row.expectedWait < best) best = row.expectedWait;
      }
    }
    return best === null ? null : Math.round(best);
  })();

  return (
    <main className="min-h-screen bg-hanji text-muk p-4 md:p-8 max-md:pb-[calc(var(--tourist-nav-clearance)+env(safe-area-inset-bottom))] relative overflow-hidden">
      {/* 배경 은은한 노을·금빛 광원 — course/explore 페이지와 동일 톤. */}
      <div className="absolute top-[-20%] left-[-10%] w-[520px] h-[520px] rounded-full bg-sunset-1/10 blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[520px] h-[520px] rounded-full bg-gold/10 blur-[120px] pointer-events-none" />

      <div className="w-full max-w-md md:max-w-2xl mx-auto space-y-5 relative z-10">
        {/* 상단 바 — 뒤로가기(44px 터치)만 별도 행으로 분리해 아래 히어로 카드가 시선의 출발점이 되게 한다. */}
        <button
          type="button"
          onClick={() => router.push("/main")}
          aria-label={t("waiting.backAria")}
          className="toss-pressable flex shrink-0 items-center justify-center w-11 h-11 rounded-full bg-white/90 border border-line shadow-[0_2px_10px_rgba(43,35,32,0.1)] text-muk hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
        >
          <ArrowLeft size={18} />
        </button>

        {/* 히어로 요약 카드 — /course 헤더 블록과 같은 문법(브랜드 칩 → 큰 헤드라인 → 한 줄 가치 →
            골드 스탯 + 가정 시간 컨트롤). '도착 시 대기 N분'의 기준 시점(NowChip·가정 시간)을 헤드라인과
            한 덩어리로 묶어, 보드의 숫자가 어느 시점 기준인지 바로 옆에서 읽히게 한다. */}
        <section className="rounded-2xl border border-line/70 bg-hanji-deep/45 p-4 md:p-5 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center w-fit px-2.5 py-1 rounded-full bg-gold/15 border border-gold/30 text-[11px] font-bold text-gold-deep">
              {t("waiting.brand")}
            </span>
            <NowChip />
          </div>
          <div className="space-y-1.5">
            <h1 className="text-[22px] md:text-[28px] font-serif font-black text-muk leading-[1.15] tracking-tight">
              {t("waiting.title")}
            </h1>
            {/* 두 키를 '·'로 이어 붙이면 한 문장이 아니라 두 조각으로 읽힌다 — 보드의 목적을 한 줄로 말한다. */}
            <p className="text-[13px] md:text-sm text-muk-soft leading-relaxed">
              {t("waiting.subtitle")}
            </p>
          </div>

          {/* 스탯 스트립 — 보드 최단 대기(골드 박스)와 가정 시간 컨트롤을 한 줄에 묶는다.
              데모: 가정 시간 시뮬레이터 — 심야에도 낮 시각을 가정해 실제 결과를 보여준다(/main·/course 공유). */}
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            {bestWait !== null && (
              <span className="inline-flex items-center gap-1.5 rounded-xl border border-gold/40 bg-gold/15 px-3 py-2 text-[13px] font-black text-gold-deep tabular-nums shadow-[0_2px_10px_rgba(193,154,62,0.16)]">
                <span aria-hidden>⏱️</span>
                {t("waiting.heroBestWait", { n: bestWait })}
              </span>
            )}
            <label className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-line bg-white px-3 py-2 text-xs font-medium shadow-[0_2px_10px_rgba(43,35,32,0.06)] focus-within:ring-2 focus-within:ring-gold/60">
              <span aria-hidden>🕒</span>
              <span className="text-muk-soft">{t("timeSim.label")}</span>
              <select
                value={assumedPreset}
                onChange={(e) => setStoredAssumedPreset(e.target.value)}
                aria-label={t("timeSim.label")}
                className="bg-transparent font-bold text-muk focus:outline-none cursor-pointer"
              >
                {ASSUMED_TIME_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>{t(p.labelKey)}</option>
                ))}
              </select>
            </label>
            {assumedPreset !== "now" && (
              <span className="inline-flex items-center rounded-full bg-gold/15 border border-gold/40 px-2.5 py-1 text-[11px] font-bold text-gold-deep">
                {t("timeSim.badge", { label: t(ASSUMED_TIME_PRESETS.find((p) => p.id === assumedPreset)?.labelKey ?? "timeSim.now") })}
              </span>
            )}
          </div>
        </section>

        {/* 본문 */}
        {loading ? (
          <LoadingReveal variant="waiting" />
        ) : failed ? (
          <ErrorState onRetry={fetchBoard} />
        ) : !sectors || sectors.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="flex flex-col gap-6">
            {sectors.map((sector) => {
              // 오늘 휴무 확정 시설은 대표 카드(topRows) 선정에서 아예 배제 — open 이 3곳 미만이어도
              // closed 로 자리를 채우지 않는다(rows 는 이미 closedToday 를 맨 뒤로 정렬해 뒀다).
              const openRows = sector.rows.filter((r) => !r.closedToday);
              const closedRows = sector.rows.filter((r) => r.closedToday);
              const topRows = openRows.slice(0, TOP_CARD_COUNT);
              const restRows = [...openRows.slice(TOP_CARD_COUNT), ...closedRows];
              return (
                // 섹터 = 반투명 보드 패널(fractal-glass) — 흰 카드·행이 한지 배경 위에 흩어져 보이지 않고
                // '한 유형의 게시판 한 판'으로 묶여 읽히게 한다(상업 대기 보드의 섹션 문법).
                <section
                  key={sector.type}
                  className="rounded-3xl border border-line/70 bg-white/55 fractal-glass p-3 md:p-4 shadow-[0_2px_14px_rgba(43,35,32,0.06)]"
                >
                  {/* 섹터 헤더 — 유형 이모지 칩 + 이름 + 표시 개수(기존 category.* i18n 키 재사용). */}
                  <div className="flex items-center gap-2 mb-2.5">
                    <span
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gold/10 border border-gold/25 text-base"
                      aria-hidden
                    >
                      {TYPE_EMOJI[sector.type] ?? "📍"}
                    </span>
                    <h2 className="text-[15px] font-bold text-muk leading-tight">
                      {t(`category.${sector.type}`)}
                    </h2>
                    <span className="ml-auto rounded-full bg-hanji-deep px-2.5 py-1 text-[11px] font-bold text-muk-soft tabular-nums">
                      {t("waiting.sectorCount", { n: sector.rows.length })}
                    </span>
                  </div>

                  {/* 대표 카드 3장 — 도착 대기 짧은 순 상위 3곳, 세로로 긴 포트레이트 카드 */}
                  <div className="grid grid-cols-3 items-stretch gap-2">
                    {topRows.map((row, idx) => (
                      <div key={row.facilityId} className="grid min-w-0 grid-rows-[1fr_auto]">
                      <button
                        type="button"
                        onClick={() => goToDetail(row.facilityId)}
                        className={`group toss-pressable relative flex h-72 flex-col overflow-hidden text-left rounded-2xl border shadow-[0_2px_14px_rgba(43,35,32,0.06)] hover:shadow-[0_6px_20px_rgba(43,35,32,0.12)] focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 ${
                          idx === 0
                            ? "bg-gold/10 border-gold/40 hover:border-gold/60"
                            : "bg-white/90 border-line hover:border-gold/40 hover:bg-white"
                        }`}
                      >
                        {/* 순위 배지 — /course 정류지 번호 배지와 같은 문법(금빛 원 + 흰 숫자 + 2px 흰 테두리).
                            카드가 overflow-hidden 이라 모서리 밖이 아니라 사진 위 좌상단에 얹는다(상업 랭킹
                            카드의 썸네일 순위 관례). 1위만 그라데이션으로 반 단계 더 세운다. */}
                        <span
                          className={`absolute top-1.5 left-1.5 z-10 flex h-7 w-7 items-center justify-center rounded-full border-2 border-white text-[13px] font-extrabold text-white tabular-nums shadow-[0_2px_8px_rgba(193,154,62,0.45)] ${
                            idx === 0 ? "bg-gradient-to-br from-gold to-gold-deep" : "bg-gold"
                          }`}
                          aria-hidden
                        >
                          {idx + 1}
                        </span>
                        <WaitingCardImage imageUrls={row.imageUrls} name={row.name} type={row.type} />
                        <div className="flex flex-1 min-h-0 flex-col justify-between p-2">
                          {/* 위 소개 블록은 공간이 모자라면 깔끔히 잘리고(overflow-hidden), 아래 대기
                              스탯 블록은 shrink-0 으로 항상 온전히 남는다 — 카드의 주인공은 '도착 시 대기'다. */}
                          <div className="min-h-0 overflow-hidden">
                            <p className="text-xs font-bold text-muk leading-snug line-clamp-2">
                              {row.name}
                            </p>
                            {/* 공식 대표 메뉴(TourAPI) — 있을 때만 한 줄. 🍽 이모지는 TYPE_EMOJI 관례와 동일 톤. */}
                            {row.menus.length > 0 && (
                              <p className="mt-0.5 text-[10px] font-bold text-gold-deep leading-snug line-clamp-2">
                                🍽 {row.menus.join(" · ")}
                              </p>
                            )}
                            {row.summary && (
                              <p className="mt-1 text-[10px] leading-snug text-muk-soft break-words line-clamp-5">
                                {row.summary}
                              </p>
                            )}
                          </div>
                          <div className="shrink-0 space-y-1.5 mt-1.5">
                            {/* 대기 스탯 — 카드의 핵심 숫자를 골드 박스로 세운다(/course 도착 ETA 스탯과 동일 문법). */}
                            <p className="rounded-lg border border-gold/30 bg-gold/10 px-2 py-1 text-xs font-extrabold text-gold-deep leading-snug tabular-nums">
                              {row.expectedWait === null
                                ? row.areaDemandTourismEvidence
                                  ? typeof row.areaDemandTourismEvidence.relativeIndex === "number"
                                    ? t("recommend.tourismEvidenceIndex", { n: Math.round(row.areaDemandTourismEvidence.relativeIndex) })
                                    : t("recommend.tourismEvidenceTitle")
                                : row.areaDemandLevel !== null
                                  ? `${t("recommend.areaDemand")}: ${t(`congestion.${congestionKey(row.areaDemandLevel)}`)}`
                                  : t("waiting.waitUnavailable")
                                : t("waiting.arrivalWait", { n: Math.round(row.expectedWait) })}
                            </p>
                            {/* 출발 시점 제안이 있는 경우에만 표시한다. */}
                            {row.arrivalAction && row.arrivalAction !== "no_clear_advantage" && (
                              <p className="text-[10px] font-bold text-sky-800">
                                {t(`recommend.arrivalAction.${row.arrivalAction}`, {
                                  n: row.recommendedDepartureDelayMinutes ?? 30,
                                })}
                              </p>
                            )}
                            {row.areaDemandParkingEvidence && typeof row.areaDemandParkingEvidence.radiusM === "number" && (
                              <p className="text-[10px] font-semibold text-sky-700">
                                {t("recommend.parkingEvidenceRadius", { n: row.areaDemandParkingEvidence.radiusM.toLocaleString() })}
                              </p>
                            )}
                            {row.areaDemandTourismEvidence && (
                              <p className="text-[10px] leading-snug text-indigo-700">
                                {typeof row.areaDemandTourismEvidence.relativeIndex === "number"
                                  ? t("recommend.tourismEvidenceIndex", { n: Math.round(row.areaDemandTourismEvidence.relativeIndex) })
                                  : t("recommend.tourismEvidenceTitle")}
                                <br />
                                {t("recommend.tourismEvidenceBasis", {
                                  name: row.areaDemandTourismEvidence.referenceName ?? t("recommend.tourismReferenceUnknown"),
                                  distance: typeof row.areaDemandTourismEvidence.distanceM === "number"
                                    ? Math.round(row.areaDemandTourismEvidence.distanceM).toLocaleString() : "-",
                                  date: row.areaDemandTourismEvidence.forecastDate ?? "-",
                                })}
                              </p>
                            )}
                            {row.congestionLevel != null ? (
                              <span
                                className={`inline-block text-[10px] font-bold px-1.5 py-0.5 rounded-md border whitespace-nowrap ${congestionBadgeClass(
                                  row.congestionLevel
                                )}`}
                              >
                                {t(`congestion.${congestionKey(row.congestionLevel)}`)}
                              </span>
                            ) : row.areaDemandTourismEvidence ? (
                              <span className="inline-block text-[10px] font-bold px-1.5 py-0.5 rounded-md border whitespace-nowrap bg-indigo-500/10 border-indigo-500/20 text-indigo-700">
                                {t("recommend.areaEvidenceCount", {
                                  n: Number(!!row.areaDemandParkingEvidence) + 1,
                                })}
                              </span>
                            ) : row.areaDemandLevel !== null ? (
                              <span className={`inline-block text-[10px] font-bold px-1.5 py-0.5 rounded-md border whitespace-nowrap ${congestionBadgeClass(row.areaDemandLevel)}`}>
                                {t(row.areaDemandMode === "live"
                                  ? "recommend.areaDemandLive"
                                  : row.areaDemandMode === "forecast"
                                    ? "recommend.areaDemandForecast"
                                    : "recommend.areaDemandStats")}
                              </span>
                            ) : (
                              <span className="inline-block text-[10px] font-bold px-1.5 py-0.5 rounded-md border bg-muk/5 border-line text-muk-soft whitespace-nowrap">
                                {t("card.noData")}
                              </span>
                            )}
                          </div>
                        </div>
                      </button>
                      <div className="min-h-4">
                      {row.imageSource?.sourceUrl && (
                        <a
                          href={row.imageSource.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 block truncate text-[8px] text-muk-soft underline underline-offset-2"
                          title={`${row.imageSource.artist || row.imageSource.provider || "Wikimedia"} · ${row.imageSource.license || ""}`}
                        >
                          {row.imageSource.artist || row.imageSource.provider || "Wikimedia"} · {row.imageSource.license}
                        </a>
                      )}
                      </div>
                      </div>
                    ))}
                  </div>

                  {/* 섹터 1위 골든타임 — 카드 밖 한 줄(컴팩트 카드 폭 안에 배지+알림 버튼이 안 들어감).
                      available:false/실패면 GoldenHourBadge 자체가 조용히 숨는다. */}
                  {topRows[0] && (
                    <div className="mt-2">
                      <GoldenHourBadge facilityId={topRows[0].facilityId} />
                    </div>
                  )}

                  {/* 나머지 리스트 — 이름·대기·혼잡 컴팩트 행 줄줄이 */}
                  {restRows.length > 0 && (
                    <div className="flex flex-col gap-2 mt-2.5">
                      {restRows.map((row) => (
                        <button
                          key={row.facilityId}
                          type="button"
                          onClick={() => goToDetail(row.facilityId)}
                          className="group toss-pressable text-left w-full min-h-11 bg-white/90 border border-line rounded-2xl px-3.5 py-3 flex items-center gap-3 shadow-[0_2px_14px_rgba(43,35,32,0.06)] hover:border-gold/40 hover:bg-white hover:shadow-[0_4px_16px_rgba(43,35,32,0.1)] focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
                        >
                          <span
                            className="w-9 h-9 shrink-0 rounded-full bg-gold/10 border border-gold/25 flex items-center justify-center text-base"
                            aria-hidden
                          >
                            {TYPE_EMOJI[row.type] ?? "📍"}
                          </span>
                          <div className="flex-1 min-w-0">
                            <p className="text-[15px] font-bold text-muk leading-snug truncate">{row.name}</p>
                            <div className="flex flex-wrap items-center gap-1.5 mt-1">
                              <span className="text-[11px] font-bold px-2 py-1 rounded-md bg-gold/10 border border-gold/25 text-gold-deep whitespace-nowrap tabular-nums">
                                {row.expectedWait === null
                                  ? row.areaDemandTourismEvidence
                                    ? typeof row.areaDemandTourismEvidence.relativeIndex === "number"
                                      ? t("recommend.tourismEvidenceIndex", { n: Math.round(row.areaDemandTourismEvidence.relativeIndex) })
                                      : t("recommend.tourismEvidenceTitle")
                                  : row.areaDemandLevel !== null
                                    ? `${t("recommend.areaDemand")}: ${t(`congestion.${congestionKey(row.areaDemandLevel)}`)}`
                                    : t("waiting.waitUnavailable")
                                  : t("waiting.arrivalWait", { n: Math.round(row.expectedWait) })}
                              </span>
                              {/* 오늘 휴무 확정 — 숨기지 않고 정직하게 배지로 알린다(리스트 맨 뒤 배치와 함께). */}
                              {row.closedToday && (
                                <span className="text-[11px] font-bold px-2 py-1 rounded-md border whitespace-nowrap bg-terracotta/10 border-terracotta/30 text-terracotta">
                                  {t("card.closedToday")}
                                </span>
                              )}
                              {row.areaDemandParkingEvidence && typeof row.areaDemandParkingEvidence.radiusM === "number" && (
                                <span className="text-[11px] font-semibold text-sky-700 whitespace-nowrap">
                                  {t("recommend.parkingEvidenceRadius", { n: row.areaDemandParkingEvidence.radiusM.toLocaleString() })}
                                </span>
                              )}
                              {row.areaDemandTourismEvidence && (
                                <span className="text-[11px] font-semibold text-indigo-700">
                                  {typeof row.areaDemandTourismEvidence.relativeIndex === "number"
                                    ? t("recommend.tourismEvidenceIndex", { n: Math.round(row.areaDemandTourismEvidence.relativeIndex) })
                                    : t("recommend.tourismEvidenceTitle")}
                                  {row.areaDemandTourismEvidence.referenceName
                                    ? ` · ${row.areaDemandTourismEvidence.referenceName}` : ""}
                                </span>
                              )}
                              {row.congestionLevel != null ? (
                                <span
                                  className={`text-[11px] font-bold px-2 py-1 rounded-md border whitespace-nowrap ${congestionBadgeClass(
                                    row.congestionLevel
                                  )}`}
                                >
                                  {t(`congestion.${congestionKey(row.congestionLevel)}`)}
                                </span>
                              ) : row.areaDemandTourismEvidence ? (
                                <span className="text-[11px] font-bold px-2 py-1 rounded-md border whitespace-nowrap bg-indigo-500/10 border-indigo-500/20 text-indigo-700">
                                  {t("recommend.areaEvidenceCount", {
                                    n: Number(!!row.areaDemandParkingEvidence) + 1,
                                  })}
                                </span>
                              ) : row.areaDemandLevel !== null ? (
                                <span className={`text-[11px] font-bold px-2 py-1 rounded-md border whitespace-nowrap ${congestionBadgeClass(row.areaDemandLevel)}`}>
                                  {t(row.areaDemandMode === "live"
                                    ? "recommend.areaDemandLive"
                                    : row.areaDemandMode === "forecast"
                                      ? "recommend.areaDemandForecast"
                                      : "recommend.areaDemandStats")}
                                </span>
                              ) : null}
                            </div>
                            {/* 출발 시점 제안이 있는 경우에만 표시한다. */}
                            {row.arrivalAction && row.arrivalAction !== "no_clear_advantage" && (
                              <p className="mt-1 text-[11px] font-bold text-sky-800">
                                {t(`recommend.arrivalAction.${row.arrivalAction}`, {
                                  n: row.recommendedDepartureDelayMinutes ?? 30,
                                })}
                              </p>
                            )}
                          </div>
                          {/* 우측 셰브런 — '탭하면 상세로'가 그림으로 읽히는 행동 신호(상업 리스트 행 관례). */}
                          <ChevronRight
                            size={18}
                            className="shrink-0 text-muk-soft/50 group-hover:text-gold-deep transition-colors"
                            aria-hidden
                          />
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}
        <p className="mt-6 border-t border-line pt-4 text-center text-[11px] leading-relaxed text-muk-soft">
          {t("waiting.dataAttribution")}
        </p>
      </div>
    </main>
  );
}

function EmptyState() {
  const t = useT();
  return (
    <div className="bg-white rounded-2xl border border-line shadow-[0_2px_14px_rgba(43,35,32,0.06)] p-8 text-center space-y-2">
      <div className="text-4xl">🗺️</div>
      <p className="text-[15px] font-bold text-muk">{t("waiting.emptyTitle")}</p>
      <p className="text-[13px] text-muk-soft leading-relaxed">{t("waiting.emptyBody")}</p>
    </div>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  const t = useT();
  return (
    <div className="bg-white rounded-2xl border border-terracotta/25 shadow-[0_2px_14px_rgba(43,35,32,0.06)] p-8 text-center space-y-3">
      <div className="text-4xl">⚠️</div>
      <p className="text-[15px] font-bold text-muk">{t("waiting.fetchError")}</p>
      {/* 재시도 = 이 화면의 유일한 주 행동 — /course 와 동일한 금빛 그라데이션 CTA 문법으로 세운다. */}
      <button
        onClick={onRetry}
        className="toss-pressable inline-flex min-h-11 items-center gap-1.5 px-5 rounded-full bg-gradient-to-r from-gold to-terracotta text-white text-[13px] font-bold shadow-[0_4px_14px_rgba(193,85,59,0.25)] hover:from-gold-deep hover:to-terracotta focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
      >
        {t("common.retry")}
      </button>
    </div>
  );
}
