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
  getCongestionEstimates,
  ASSUMED_TIME_PRESETS,
  ASSUMED_TIME_EVENT,
  assumedAtIsoForPreset,
  getStoredAssumedPreset,
  setStoredAssumedPreset,
} from "@/lib/api-client";
import { recToSpot } from "@/lib/recommender";
import { congestionDisplay, parseCongestionEstimate } from "@/lib/congestionEstimate";
// 보드의 세 숫자(예상 대기 · 혼잡 등급 · 한산해지는 시각)의 단일 소스.
import { estimateWait, displayHour, compareWaitMinutes, showsCalmLine, heroWaitCandidate, type WaitEstimate } from "@/lib/waitEstimate";
import { fetchAreaDemandCurve, type AreaDemandCurve } from "@/lib/areaDemandCurve";
// 분으로 말할 근거가 없는 카드는 등급으로 말한다 — 등급 경계는 지도·카드와 같은 공용 판정을 쓴다.
import { congestionKey } from "@/lib/congestionScale";
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
// v2: 카드가 대기 추정에 쓰는 필드(capacity·rankingWait·baselineWait)가 늘어 옛 캐시는 버린다.
const BOARD_CACHE_KEY = "nextspot_waiting_board_v2";
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
  // 엔진이 순위에 실제로 쓴 대기(breakdown.ranking_wait_time) — 화면엔 '추정'으로 표기한다.
  rankingWait: number | null;
  // 근거 없는 후보의 업종 기준선 대기(breakdown.industry_baseline_wait_time). 이 시설의 측정값이 아니다.
  baselineWait: number | null;
  // 좌석/수용 인원 — 같은 수요라도 큰 가게는 줄이 짧다(대기 추정의 시설 규모 항).
  capacity: number | null;
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

// 혼잡 등급(여유·보통·혼잡) 배지 색 — /course CONGESTION_CLASS 와 같은 팔레트를 3단계로 쓴다.
// 같은 '여유'가 화면마다 다른 초록이면 같은 등급인지 헷갈린다. terracotta 는 '혼잡' 하나에만 아껴 쓴다.
// (기존 4단계 congestionKey/congestionBadgeClass 는 이 보드에서 더 이상 쓰지 않는다 — 카드가 말하는
//  등급이 '대기 기준 3단계' 하나로 통일됐다. 원시 혼잡도 배지와 섞이면 어느 쪽이 기준인지 알 수 없다.)
const gradeBadgeClass = (grade: NonNullable<WaitEstimate["grade"]>) =>
  grade === "busy"
    ? "bg-terracotta/10 border-terracotta/30 text-terracotta"
    : grade === "moderate"
    ? "bg-gold/10 border-gold/30 text-gold-deep"
    : "bg-jade/12 border-jade/30 text-jade";

// 근거 한 줄 — 이 카드의 숫자가 무엇에서 나왔는지. 새 배지를 만들지 않고 작은 회색 글씨로만 둔다.
function basisKey(basis: WaitEstimate["basis"]): string {
  switch (basis) {
    case "server": return "wait.basisServer";
    case "ranking": return "wait.basisRanking";
    case "baseline": return "wait.basisBaseline";
    case "measured": return "wait.basisMeasured";
    case "estimate": return "wait.basisEstimate";
    case "area": return "wait.basisArea";
    case "tourism": return "wait.basisTourism";
    default: return "wait.basisDefault";
  }
}

/**
 * 카드의 주인공 한 줄. 분으로 말할 근거가 있으면 분을, 없으면 그 근거가 **실제로 아는 것**
 * (시설 추정 혼잡 · 주변 권역 수요 등급 · 관광 상대지수)을 그대로 말한다.
 * 주변 주차·관광 상대지수를 '대기 N분'으로 바꾸지 않는다(docs/CONGESTION_DATA.md §2 원칙 3·4).
 */
function waitHeadline(
  est: WaitEstimate,
  row: BoardRow,
  estimateLevel: number | undefined,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  if (est.minutes !== null) {
    if (est.minutes > 0) return t("wait.minutes", { n: est.minutes });
    // '대기 없음'은 검증 예측(server)에만 허용한다 — 추정으로 0분을 단언하지 않는다(원칙 6).
    return est.basis === "server" ? t("wait.noWait") : t("wait.grade.relaxed");
  }
  if (est.basis === "estimate" && typeof estimateLevel === "number") {
    return t("card.estimateLevel", { label: t(`congestion.${congestionKey(estimateLevel)}`) });
  }
  if (est.basis === "area" && row.areaDemandLevel !== null) {
    return `${t("recommend.areaDemand")}: ${t(`congestion.${congestionKey(row.areaDemandLevel)}`)}`;
  }
  const relativeIndex = row.areaDemandTourismEvidence?.relativeIndex;
  if (est.basis === "tourism" && typeof relativeIndex === "number") {
    return t("recommend.tourismEvidenceIndex", { n: Math.round(relativeIndex) });
  }
  // 아무 근거도 없을 때 — 0분을 만들지 않고 '수집 중'이라고 둔다.
  return t("waiting.waitUnavailable");
}

/** 대표 카드의 세 숫자 블록 — ① 예상 대기 ② 혼잡 등급 ③ 한산해지는 시각. */
function WaitStats({ est, row, estimateLevel }: { est: WaitEstimate; row: BoardRow; estimateLevel?: number }) {
  const t = useT();
  const headline = waitHeadline(est, row, estimateLevel, t);
  return (
    <div className="shrink-0 space-y-1 mt-1.5">
      {/* ① 예상 대기 — 카드의 주인공. 골드 박스로 가장 크게 세운다.
          분으로 말할 근거가 없는 카드는 여기에 등급·지수가 그대로 들어온다(waitHeadline). */}
      <p className="rounded-lg border border-gold/30 bg-gold/10 px-2 py-1 text-xs font-extrabold text-gold-deep leading-snug tabular-nums">
        {headline}
      </p>
      <div className="flex flex-wrap items-center gap-1">
        {/* ② 혼잡 등급 — 분이 있을 때만 붙인다. 분이 없으면 대기 등급도 말할 수 없고,
            0분이면 위 골드 박스가 이미 같은 말('대기 없음'·'여유')을 하고 있다. */}
        {est.grade !== null && est.minutes !== null && est.minutes > 0 && (
          <span className={`inline-block text-[10px] font-bold px-1.5 py-0.5 rounded-md border whitespace-nowrap ${gradeBadgeClass(est.grade)}`}>
            {t(`wait.grade.${est.grade}`)}
          </span>
        )}
        {est.estimated && (
          <span className="inline-block text-[10px] font-bold px-1.5 py-0.5 rounded-md border bg-muk/5 border-line text-muk-soft whitespace-nowrap">
            {t("wait.estimatedTag")}
          </span>
        )}
        {row.closedToday && (
          <span className="inline-block text-[10px] font-bold px-1.5 py-0.5 rounded-md border whitespace-nowrap bg-terracotta/10 border-terracotta/30 text-terracotta">
            {t("card.closedToday")}
          </span>
        )}
      </div>
      {/* ③ 한산해지는 시각 — 분이 있는 카드는 8시간 안에 없으면 '지금이 가장 한산'. 분이 없는 카드는
          권역 수요 곡선에서 실제로 찾은 시각이 있을 때만 쓴다(showsCalmLine): 내장 시간대 곡선만으로
          한산하다고 말할 수는 없다. */}
      {showsCalmLine(est) && (
        <p className="text-[10px] font-bold leading-snug text-jade">
          {est.calmHour === null
            ? t("wait.calmNow")
            : t("wait.calmAt", { h: est.calmHour })}
        </p>
      )}
      <p className="text-[9px] leading-snug text-muk-soft line-clamp-2">
        {/* 근거가 하나도 없는 카드에는 근거 문구를 붙이지 않는다 — 위 한 줄이 '수집 중'이라고
            말해 놓고 옆에서 무슨 근거라고 하면 한 카드가 두 말을 한다. */}
        {t("wait.arrivalBasis", { h: displayHour(est.arrivalHour) })}
        {est.basis !== "default" && ` · ${t(basisKey(est.basis))}`}
      </p>
    </div>
  );
}

/** 컴팩트 행의 세 숫자 — 같은 값을 칩 한 줄로 압축한다. */
function WaitRowChips({ est, row, estimateLevel }: { est: WaitEstimate; row: BoardRow; estimateLevel?: number }) {
  const t = useT();
  const headline = waitHeadline(est, row, estimateLevel, t);
  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-1">
      <span className="text-[11px] font-bold px-2 py-1 rounded-md bg-gold/10 border border-gold/25 text-gold-deep whitespace-nowrap tabular-nums">
        {headline}
      </span>
      {est.grade !== null && est.minutes !== null && est.minutes > 0 && (
        <span className={`text-[11px] font-bold px-2 py-1 rounded-md border whitespace-nowrap ${gradeBadgeClass(est.grade)}`}>
          {t(`wait.grade.${est.grade}`)}
        </span>
      )}
      {showsCalmLine(est) && (
        <span className="text-[11px] font-bold text-jade whitespace-nowrap">
          {est.calmHour === null ? t("wait.calmNow") : t("wait.calmAt", { h: est.calmHour })}
        </span>
      )}
      {est.estimated && (
        <span className="text-[11px] font-semibold text-muk-soft whitespace-nowrap">{t("wait.estimatedTag")}</span>
      )}
      {/* 오늘 휴무 확정 — 숨기지 않고 정직하게 배지로 알린다(리스트 맨 뒤 배치와 함께). */}
      {row.closedToday && (
        <span className="text-[11px] font-bold px-2 py-1 rounded-md border whitespace-nowrap bg-terracotta/10 border-terracotta/30 text-terracotta">
          {t("card.closedToday")}
        </span>
      )}
    </div>
  );
}

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

  // ── 보드의 세 숫자(예상 대기 · 혼잡 등급 · 한산해지는 시각)를 위한 보조 피드 ──────────────
  // 추천 응답의 breakdown.waitTime 은 프로덕션에서 거의 항상 null 이라(검증 모델 미가동)
  // 그것만 믿으면 카드마다 같은 문구만 남는다. 아래 두 공개 GET 이 **시설별로 갈리는** 근거를 준다.
  //   · /congestion/estimates : 공영주차 실측 + 관광 통계로 만든 시설별 혼잡 추정(0~1)
  //   · /area-demand/forecast : 앞으로 6시간 정시별 권역 주차 수요 전망(한산해지는 시각의 근거)
  // 둘 다 실패해도 보드는 내장 시간대 곡선으로 계속 세 숫자를 보여준다(빈칸 금지).
  const [estimateLevels, setEstimateLevels] = useState<Record<string, number>>({});
  const [areaCurve, setAreaCurve] = useState<AreaDemandCurve | null>(null);

  // 가정 시각 프리셋이 가리키는 절대 시각 — 대기·한산 시각 계산의 기준점.
  // 'now' 면 현재. 프리셋이 바뀌면 곡선도 그 시각 기준으로 다시 받는다.
  const assumedIso = assumedAtIsoForPreset(assumedPreset);
  const baseAtMs = assumedIso ? new Date(assumedIso).getTime() : null;

  // 'now' 프리셋의 기준 시각은 **상태로 고정**한다. 렌더 중 new Date() 를 부르면 정적 export 의
  // 프리렌더 HTML 과 하이드레이션 결과가 갈리고, 리렌더마다 숫자가 미세하게 흔들린다.
  // 5분마다 한 번만 갱신 — 대기 추정의 시간 해상도(정시 곡선)에는 충분하다.
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 5 * 60 * 1000);
    return () => clearInterval(id);
  }, []);
  const effectiveBaseMs = baseAtMs ?? nowMs;

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    void (async () => {
      try {
        const feed = await getCongestionEstimates({ timeoutMs: 8000, signal: controller.signal });
        if (!alive || !feed?.available) return;
        const next: Record<string, number> = {};
        // 신선도(60분)·모양 검증은 공용 파서에 맡긴다 — 낡은 추정으로 '지금'을 말하지 않는다.
        for (const [facilityId, raw] of Object.entries(feed.estimates ?? {})) {
          const parsed = parseCongestionEstimate(raw);
          if (parsed) next[facilityId] = parsed.level;
        }
        setEstimateLevels(next);
      } catch { /* 추정 피드 없음 — 아래 폴백(권역 수요·상대지수)으로 계산한다 */ }
    })();
    return () => { alive = false; controller.abort(); };
  }, []);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    void (async () => {
      const curve = await fetchAreaDemandCurve(
        REGION.center.lat,
        REGION.center.lng,
        baseAtMs ? new Date(baseAtMs) : new Date(),
        controller.signal,
      );
      if (alive && Object.keys(curve).length > 0) setAreaCurve(curve);
    })();
    return () => { alive = false; controller.abort(); };
  }, [baseAtMs]);

  // 카드 한 장의 세 숫자. 렌더 중 여러 번 불리므로 순수 계산만 한다(네트워크 없음).
  const waitOf = useCallback(
    (row: BoardRow): WaitEstimate =>
      estimateWait({
        facilityType: row.type,
        serverWaitMinutes: row.expectedWait,
        rankingWaitMinutes: row.rankingWait,
        baselineWaitMinutes: row.baselineWait,
        capacity: row.capacity,
        measuredLevel: row.congestionLevel,
        estimateLevel: estimateLevels[row.facilityId] ?? null,
        areaDemandLevel: row.areaDemandLevel,
        tourismRelativeIndex: row.areaDemandTourismEvidence?.relativeIndex ?? null,
        tourismDistanceM: row.areaDemandTourismEvidence?.distanceM ?? null,
        travelMinutes: row.expectedTravel,
        baseAt: new Date(effectiveBaseMs ?? Date.now()),
        areaCurve,
      }),
    [estimateLevels, areaCurve, effectiveBaseMs],
  );

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
          rankingWait:
            typeof rec.breakdown?.rankingWaitTime === "number" ? rec.breakdown.rankingWaitTime : null,
          // 구 서버 응답에는 없는 키라 TS 계약에 없다 — 있으면 쓰고, 없으면 조용히 null.
          baselineWait: (() => {
            const b = rec.breakdown as Record<string, unknown> | undefined;
            const raw = b?.industryBaselineWaitTime ?? b?.industry_baseline_wait_time;
            return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
          })(),
          capacity: typeof rec.facility.capacity === "number" ? rec.facility.capacity : null,
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
  // (오늘 휴무가 확정된 시설은 제외). 분이 없는 카드는 후보에서 빠진다 — 0분으로 치면
  // 아무것도 모르는 곳이 '최단 대기'가 된다. 추정 0분도 빠진다(heroWaitCandidate) — 카드는 그것을
  // '여유'라고만 말하는데 히어로가 '0분'이라 단언하면 같은 값이 두 말을 한다. 추정값이 이기면 카드와
  // 똑같이 '추정'을 함께 단다.
  const bestWait = (() => {
    if (!sectors) return null;
    let best: { minutes: number; estimated: boolean } | null = null;
    for (const sector of sectors) {
      for (const row of sector.rows) {
        if (row.closedToday) continue;
        const est = waitOf(row);
        if (!heroWaitCandidate(est) || est.minutes === null) continue;
        if (best === null || est.minutes < best.minutes) {
          best = { minutes: est.minutes, estimated: est.estimated };
        }
      }
    }
    return best;
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
            {/* 카드가 무엇을 보여주는지 한 줄로 먼저 말한다 — 판단 근거를 숨기지 않는 것이 이 보드의 계약. */}
            <p className="text-[11px] text-muk-soft/90 leading-relaxed">
              {t("wait.legend")}
            </p>
          </div>

          {/* 스탯 스트립 — 보드 최단 대기(골드 박스)와 가정 시간 컨트롤을 한 줄에 묶는다.
              데모: 가정 시간 시뮬레이터 — 심야에도 낮 시각을 가정해 실제 결과를 보여준다(/main·/course 공유). */}
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            {bestWait !== null && (
              <span className="inline-flex items-center gap-1.5 rounded-xl border border-gold/40 bg-gold/15 px-3 py-2 text-[13px] font-black text-gold-deep tabular-nums shadow-[0_2px_10px_rgba(193,154,62,0.16)]">
                <span aria-hidden>⏱️</span>
                {t("waiting.heroBestWait", { n: bestWait.minutes })}
                {/* 카드마다 붙는 '추정' 라벨이 히어로에서만 빠지면 같은 숫자가 두 성격으로 읽힌다. */}
                {bestWait.estimated && (
                  <span className="rounded-md border border-line bg-white/70 px-1.5 py-0.5 text-[10px] font-bold text-muk-soft">
                    {t("wait.estimatedTag")}
                  </span>
                )}
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
              // 정렬 기준을 **화면이 실제로 보여주는 숫자**로 맞춘다. fetchBoard 의 1차 정렬은
              // 서버 대기(프로덕션에서 거의 항상 null)로만 줄을 세우므로 순위 배지 ①②③ 이 무의미했다.
              // 여기서 추정 대기로 다시 세우면 '1번이 가장 덜 기다린다'가 카드 숫자와 일치한다.
              // 분이 없는 카드는 0분이 아니라 **맨 뒤**다(compareWaitMinutes) — 근거가 없다고
              // 보드 1위에 서면 순위 배지 ①②③ 이 다시 거짓말을 한다.
              const openRows = sector.rows
                .filter((r) => !r.closedToday)
                .slice()
                .sort((a, b) => compareWaitMinutes(waitOf(a), waitOf(b)));
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
                            {/* TourAPI 소개는 2줄로 자른다 — 길게 풀어 두면 카드의 주인공(아래 세 숫자)을
                                밀어내고 눈이 먼저 가서, 보드를 훑는 목적 자체를 방해한다. */}
                            {row.summary && (
                              <p className="mt-1 text-[10px] leading-snug text-muk-soft break-words line-clamp-2">
                                {row.summary}
                              </p>
                            )}
                          </div>
                          {/* 세 숫자 — 예상 대기 / 혼잡 등급 / 한산해지는 시각. 보드 제목이 약속한 것. */}
                          <WaitStats est={waitOf(row)} row={row} estimateLevel={estimateLevels[row.facilityId]} />
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
                            {/* 컴팩트 행도 대표 카드와 **같은 세 숫자**를 같은 순서로 보여준다 —
                                보드를 아래로 훑을 때 읽는 규칙이 중간에 바뀌지 않게. */}
                            <WaitRowChips est={waitOf(row)} row={row} estimateLevel={estimateLevels[row.facilityId]} />
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
