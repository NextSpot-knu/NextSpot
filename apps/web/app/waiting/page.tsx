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
import { ArrowLeft, Crown } from "lucide-react";
import { isServiceUnavailable, recommendByType } from "@/lib/api-client";
import { recToSpot } from "@/lib/recommender";
import { REGION } from "@/lib/region";
import { useT } from "@/lib/i18n/I18nProvider";
import { GoldenHourBadge } from "@/components/GoldenHourBadge";
import NowChip from "@/components/NowChip";
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

interface BoardRow {
  facilityId: string;
  name: string;
  type: string;
  imageUrl: string | null;
  summary: string | null;
  congestionLevel: number | null;
  expectedWait: number;
  expectedTravel: number;
  // 오늘 휴무 '확정'(isClosedToday === true) 여부 — 대표 카드 선정에서 제외 + 리스트 맨 뒤 + 배지 표시용.
  closedToday: boolean;
}

// 섹터 = 한 시설 유형의 대기 짧은 순 정렬 목록. rows 가 비면 섹터 자체를 렌더하지 않는다.
interface Sector {
  type: string;
  rows: BoardRow[];
}

// 카드 상단 혼잡 pill 과 동일한 4단계 임계값(혼잡/보통/여유/한산) — RecommendationCard 미러.
const congestionKey = (c: number) =>
  c >= 0.75 ? "busy" : c >= 0.5 ? "moderate" : c >= 0.25 ? "relaxed" : "quiet";

// 혼잡 배지 색상 클래스 — 대표 카드·리스트 행에서 공유.
const congestionBadgeClass = (c: number) =>
  c >= 0.75
    ? "bg-terracotta/10 border-terracotta/30 text-terracotta"
    : c >= 0.5
    ? "bg-gold/10 border-gold/30 text-gold-deep"
    : c >= 0.25
    ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-600"
    : "bg-jade/10 border-jade/30 text-jade";

export default function WaitingBoardPage() {
  const router = useRouter();
  const t = useT();

  const [sectors, setSectors] = useState<Sector[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  // main 과 동일한 기본 좌표 폴백(경주 황리단길 중심) — 지역 단일 소스(REGION)에서 가져온다.
  const userLocation = { lat: REGION.center.lat, lng: REGION.center.lng };

  // 세션 부트스트랩 유예 자동 재시도 1회 플래그(아래 fetchBoard 참조)
  const retriedRef = useRef(false);
  // JWKS 등 서버 일시 장애(503)는 짧은 backoff 뒤 1회만 별도 재시도한다.
  const serviceUnavailableRetriedRef = useRef(false);

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
    setLoading(true);
    setFailed(false);

    // 4유형을 병렬 조회하되 allSettled 로 부분 실패를 흡수한다 — 일부만 살아 있어도 나머지 섹터는 채운다.
    // 전부 실패했을 때만 '백엔드 미가용'으로 판정(정직한 에러 상태 + 재시도).
    const results = await Promise.allSettled(
      BOARD_TYPES.map((type) => recommendByType(type, userLocation, [], PER_TYPE_LIMIT))
    );

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
        return {
          facilityId: rec.facility.id,
          name: rec.facility.name,
          type: rec.facility.type,
          imageUrl: rec.facility.imageUrl ?? null,
          // TourAPI 소개를 우선하고, 없으면 실제 주소를 짧은 보조 설명으로 사용한다.
          // 둘 다 없을 때는 내용을 지어내지 않고 설명 영역을 숨긴다.
          summary: rec.facility.overview?.trim() || rec.facility.address?.trim() || null,
          congestionLevel:
            typeof rec.facility.congestionLevel === "number" ? rec.facility.congestionLevel : null,
          expectedWait: spot.expectedWait,
          expectedTravel: spot.expectedTravel,
          // 휴무 '확정'(true)만 표시 — 모름(null)/영업 확정(false)은 평소처럼 취급(정직성: 과판정 금지).
          closedToday: isClosedToday(restDateRaw) === true,
        };
      });
      // 대기 짧은 순 정렬은 그대로 유지하되, 오늘 휴무 확정 시설은 항상 맨 뒤로 보낸다
      // (대표 카드가 rows 앞쪽 3개를 그대로 슬라이스하지 않도록 아래에서 open/closed 를 명시적으로 분리한다).
      rows.sort((a, b) => {
        if (a.closedToday !== b.closedToday) return a.closedToday ? 1 : -1;
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
      setFailed(true);
      setSectors(null);
      setLoading(false);
      return;
    }

    setSectors(nextSectors);
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetchBoard();
  }, [fetchBoard]);

  return (
    <main className="min-h-screen bg-hanji text-muk p-4 md:p-8 max-md:pb-[calc(80px+env(safe-area-inset-bottom))] relative overflow-hidden">
      {/* 배경 은은한 노을·금빛 광원 — course/explore 페이지와 동일 톤. */}
      <div className="absolute top-[-20%] left-[-10%] w-[520px] h-[520px] rounded-full bg-sunset-1/10 blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[520px] h-[520px] rounded-full bg-gold/10 blur-[120px] pointer-events-none" />

      <div className="w-full max-w-md md:max-w-2xl mx-auto space-y-5 relative z-10">
        {/* 헤더 */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => router.push("/main")}
            aria-label={t("waiting.backAria")}
            className="flex shrink-0 items-center justify-center w-10 h-10 rounded-full bg-white/90 border border-line shadow-[0_2px_10px_rgba(43,35,32,0.1)] text-muk hover:bg-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
          >
            <ArrowLeft size={18} />
          </button>
          <div className="min-w-0">
            {/* 브랜드 칩 + 현재 시각 — '도착 시 대기 N분'의 기준 시점을 명시(예측 수치 혼동 방지). */}
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center w-fit px-2.5 py-1 rounded-full bg-gold/10 border border-gold/25 text-[11px] font-bold text-gold-deep">
                {t("waiting.brand")}
              </span>
              <NowChip />
            </div>
            <h1 className="text-xl md:text-2xl font-serif font-bold text-muk leading-tight mt-1">
              {t("waiting.title")}
            </h1>
          </div>
        </div>
        <p className="text-xs md:text-sm text-muk-soft leading-relaxed">{t("waiting.subtitle")}</p>

        {/* 본문 */}
        {loading ? (
          <BoardSkeleton />
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
                <section key={sector.type}>
                  {/* 섹터 헤더 — 기존 category.* i18n 키 재사용(신규 키 없음). */}
                  <h2 className="flex items-center gap-1.5 text-sm font-bold text-muk mb-2">
                    <span aria-hidden>{TYPE_EMOJI[sector.type] ?? "📍"}</span>
                    {t(`category.${sector.type}`)}
                  </h2>

                  {/* 대표 카드 3장 — 도착 대기 짧은 순 상위 3곳, 세로로 긴 포트레이트 카드 */}
                  <div className="grid grid-cols-3 gap-2">
                    {topRows.map((row, idx) => (
                      <button
                        key={row.facilityId}
                        type="button"
                        onClick={() => goToDetail(row.facilityId)}
                        className={`group relative flex flex-col overflow-hidden text-left aspect-[3/4] rounded-2xl border shadow-[0_2px_14px_rgba(43,35,32,0.06)] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 ${
                          idx === 0
                            ? "bg-gold/10 border-gold/40 hover:border-gold/60"
                            : "bg-white/90 border-line hover:border-gold/40 hover:bg-white"
                        }`}
                      >
                        {/* 1위 표식(왕관) — 골든타임 배지는 카드 폭이 좁아 안 들어가므로 카드 밖 한 줄로 뺀다. */}
                        {idx === 0 && (
                          <span
                            className="absolute -top-1.5 -left-1.5 w-5 h-5 rounded-full bg-gold text-white flex items-center justify-center shadow-[0_1px_4px_rgba(43,35,32,0.35)]"
                            aria-hidden
                          >
                            <Crown size={11} strokeWidth={2.5} />
                          </span>
                        )}
                        {row.imageUrl ? (
                          // TourAPI 원본 이미지 도메인이 다양하고 정적 export이므로 img를 직접 사용한다.
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={row.imageUrl}
                            alt={row.name}
                            loading="lazy"
                            onError={(e) => { e.currentTarget.style.display = "none"; }}
                            className="w-full h-[38%] shrink-0 object-cover border-b border-line"
                          />
                        ) : (
                          <div className="h-[26%] shrink-0 flex items-center justify-center bg-hanji-deep/70 border-b border-line text-2xl" aria-hidden>
                            {TYPE_EMOJI[row.type] ?? "📍"}
                          </div>
                        )}
                        <div className="flex flex-1 min-h-0 flex-col justify-between p-2">
                          <div>
                            <p className="text-[11px] font-bold text-muk leading-snug line-clamp-2">
                              {row.name}
                            </p>
                            {row.summary && (
                              <p className="mt-1 text-[9px] leading-snug text-muk-soft line-clamp-2">
                                {row.summary}
                              </p>
                            )}
                          </div>
                          <div className="space-y-1 mt-1">
                            <p className="text-xs font-extrabold text-gold-deep leading-tight">
                              {t("waiting.arrivalWait", { n: Math.round(row.expectedWait) })}
                            </p>
                            {row.congestionLevel != null ? (
                              <span
                                className={`inline-block text-[9px] font-bold px-1.5 py-0.5 rounded-md border whitespace-nowrap ${congestionBadgeClass(
                                  row.congestionLevel
                                )}`}
                              >
                                {t(`congestion.${congestionKey(row.congestionLevel)}`)}
                              </span>
                            ) : (
                              <span className="inline-block text-[9px] font-bold px-1.5 py-0.5 rounded-md border bg-muk/5 border-line text-muk-soft whitespace-nowrap">
                                {t("card.noData")}
                              </span>
                            )}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>

                  {/* 섹터 1위 골든타임 — 카드 밖 한 줄(컴팩트 카드 폭 안에 배지+알림 버튼이 안 들어감).
                      available:false/실패면 GoldenHourBadge 자체가 조용히 숨는다. */}
                  {topRows[0] && (
                    <div className="mt-1.5">
                      <GoldenHourBadge facilityId={topRows[0].facilityId} />
                    </div>
                  )}

                  {/* 나머지 리스트 — 이름·대기·혼잡 컴팩트 행 줄줄이 */}
                  {restRows.length > 0 && (
                    <div className="flex flex-col gap-2 mt-2">
                      {restRows.map((row) => (
                        <button
                          key={row.facilityId}
                          type="button"
                          onClick={() => goToDetail(row.facilityId)}
                          className="group text-left w-full bg-white/90 border border-line rounded-2xl px-3.5 py-2.5 flex items-center gap-2.5 shadow-[0_2px_14px_rgba(43,35,32,0.06)] hover:border-gold/40 hover:bg-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
                        >
                          <span
                            className="w-7 h-7 shrink-0 rounded-full bg-gold/10 border border-gold/25 flex items-center justify-center text-sm"
                            aria-hidden
                          >
                            {TYPE_EMOJI[row.type] ?? "📍"}
                          </span>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-bold text-muk leading-snug truncate">{row.name}</p>
                            <div className="flex flex-wrap items-center gap-1.5 mt-1">
                              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-gold/10 border border-gold/25 text-gold-deep whitespace-nowrap">
                                {t("waiting.arrivalWait", { n: Math.round(row.expectedWait) })}
                              </span>
                              {/* 오늘 휴무 확정 — 숨기지 않고 정직하게 배지로 알린다(리스트 맨 뒤 배치와 함께). */}
                              {row.closedToday && (
                                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md border whitespace-nowrap bg-terracotta/10 border-terracotta/30 text-terracotta">
                                  {t("card.closedToday")}
                                </span>
                              )}
                              {row.congestionLevel != null ? (
                                <span
                                  className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md border whitespace-nowrap ${congestionBadgeClass(
                                    row.congestionLevel
                                  )}`}
                                >
                                  {t(`congestion.${congestionKey(row.congestionLevel)}`)}
                                </span>
                              ) : (
                                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md border bg-muk/5 border-line text-muk-soft whitespace-nowrap">
                                  {t("card.noData")}
                                </span>
                              )}
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}

function BoardSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden>
      {[0, 1].map((s) => (
        <div key={s} className="space-y-2">
          <div className="h-4 w-20 bg-hanji-deep rounded animate-pulse" />
          <div className="grid grid-cols-3 gap-2">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="aspect-[3/4] bg-white/70 border border-line rounded-2xl p-2 animate-pulse"
              >
                <div className="w-6 h-6 rounded-full bg-hanji-deep" />
                <div className="h-3 bg-hanji-deep rounded w-full mt-2" />
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-2 mt-2">
            {[0, 1].map((i) => (
              <div
                key={i}
                className="bg-white/70 border border-line rounded-2xl px-3.5 py-2.5 flex items-center gap-2.5 animate-pulse"
              >
                <div className="w-7 h-7 rounded-full bg-hanji-deep shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-3.5 bg-hanji-deep rounded w-1/2" />
                  <div className="h-3 bg-hanji-deep rounded w-1/3" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  const t = useT();
  return (
    <div className="bg-white rounded-2xl border border-line shadow-[0_2px_14px_rgba(43,35,32,0.06)] p-8 text-center space-y-2">
      <div className="text-3xl">🗺️</div>
      <p className="text-sm font-semibold text-muk">{t("waiting.emptyTitle")}</p>
      <p className="text-xs text-muk-soft leading-relaxed">{t("waiting.emptyBody")}</p>
    </div>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  const t = useT();
  return (
    <div className="bg-white rounded-2xl border border-terracotta/25 shadow-[0_2px_14px_rgba(43,35,32,0.06)] p-8 text-center space-y-3">
      <div className="text-3xl">⚠️</div>
      <p className="text-sm font-semibold text-muk">{t("waiting.fetchError")}</p>
      <button
        onClick={onRetry}
        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-gold text-white text-xs font-bold hover:bg-gold-deep transition-colors"
      >
        {t("common.retry")}
      </button>
    </div>
  );
}
