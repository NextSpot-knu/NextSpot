"use client";

// 스마트 줄서기 보드(정보형) — "지금 출발하면?" : 식당·관광지를 도착 시점 예상 대기가 짧은 순으로
// 보여주는 정보 전용 보드다. 새 예약/줄서기 백엔드를 만들지 않고, 기존 SPOT 추천
// (recommendByType → breakdown.waitTime/travelTime)을 재사용해 "얼마나 기다릴지"만 보여준다.
//
// 위치는 main/page.tsx 와 동일한 기본 좌표 폴백(REGION.center)을 쓴다 — 이 보드는 별도로 GPS 를
// 새로 얻지 않는다(관광객이 지도에서 이미 위치를 확인한 뒤 들어오는 보조 정보 화면이라는 전제).
//
// 백엔드 미가용(POST /api/v1/recommendations/by-type 실패) 시 무한 스켈레톤 대신
// "예측 서버 연결 안 됨" 빈 상태 + 재시도 버튼을 보여준다(course/page.tsx 의 ErrorState 와 동일 사상).
// 정적 export(SSR) 안전: 브라우저 전용 API 는 쓰지 않는다(REGION 은 순수 상수).

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { recommendByType } from "@/lib/api-client";
import { recToSpot } from "@/lib/recommender";
import { REGION } from "@/lib/region";
import { useT } from "@/lib/i18n/I18nProvider";
import { GoldenHourBadge } from "@/components/GoldenHourBadge";

// 시설 종류 이모지 — course/page.tsx TYPE_OPTIONS 와 동일 매핑(레포 전역 관례 통일).
const TYPE_EMOJI: Record<string, string> = {
  restaurant: "🍴",
  cafe: "☕",
  attraction: "📸",
  culture: "🏛️",
};

// 보드에 태울 시설 종류 — 스펙: restaurant/attraction("지금 출발하면?" 대상은 식당·관광지 위주).
const BOARD_TYPES = ["restaurant", "attraction"] as const;

// 종류당 조회 개수(합쳐서 대기 짧은 순 정렬) — 과호출 방지를 위한 상한.
const PER_TYPE_LIMIT = 8;
// 골든타임 배지는 상위 N개 행만 지연 조회(연쇄 API 호출 최소화 — GoldenHourBadge 자체도 lazy).
const GOLDEN_HOUR_TOP_N = 5;

interface BoardRow {
  facilityId: string;
  name: string;
  type: string;
  congestionLevel: number | null;
  expectedWait: number;
  expectedTravel: number;
}

// 카드 상단 혼잡 pill 과 동일한 4단계 임계값(혼잡/보통/여유/한산) — RecommendationCard 미러.
const congestionKey = (c: number) =>
  c >= 0.75 ? "busy" : c >= 0.5 ? "moderate" : c >= 0.25 ? "relaxed" : "quiet";

export default function WaitingBoardPage() {
  const router = useRouter();
  const t = useT();

  const [rows, setRows] = useState<BoardRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  // main 과 동일한 기본 좌표 폴백(경주 황리단길 중심) — 지역 단일 소스(REGION)에서 가져온다.
  const userLocation = { lat: REGION.center.lat, lng: REGION.center.lng };

  // 세션 부트스트랩 유예 자동 재시도 1회 플래그(아래 fetchBoard 참조)
  const retriedRef = useRef(false);

  const fetchBoard = useCallback(async () => {
    setLoading(true);
    setFailed(false);

    // 두 종류를 병렬 조회하되 allSettled 로 부분 실패를 흡수한다 — 한쪽만 살아 있어도 보드를 채운다.
    // 둘 다 실패했을 때만 '백엔드 미가용'으로 판정(정직한 에러 상태 + 재시도).
    const results = await Promise.allSettled(
      BOARD_TYPES.map((type) => recommendByType(type, userLocation, [], PER_TYPE_LIMIT))
    );

    const merged: BoardRow[] = [];
    let anySucceeded = false;
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      anySucceeded = true;
      for (const rec of r.value) {
        const spot = recToSpot(rec);
        merged.push({
          facilityId: rec.facility.id,
          name: rec.facility.name,
          type: rec.facility.type,
          congestionLevel:
            typeof rec.facility.congestionLevel === "number" ? rec.facility.congestionLevel : null,
          expectedWait: spot.expectedWait,
          expectedTravel: spot.expectedTravel,
        });
      }
    }

    if (!anySucceeded) {
      // 첫 진입 직행 시 익명 세션 부트스트랩(SessionBootstrap)이 끝나기 전 401 로 전멸할 수 있다
      // (실측 재현). 유예 2.5초 후 자동 1회만 재시도 — 그래도 실패하면 정직한 에러+수동 재시도.
      if (!retriedRef.current) {
        retriedRef.current = true;
        setTimeout(() => { void fetchBoard(); }, 2500);
        return; // loading 유지(스켈레톤) — 유예는 유한(1회)이라 무한 스켈레톤 아님
      }
      setFailed(true);
      setRows(null);
      setLoading(false);
      return;
    }

    merged.sort((a, b) => a.expectedWait - b.expectedWait);
    setRows(merged);
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
            <span className="inline-flex items-center w-fit px-2.5 py-1 rounded-full bg-gold/10 border border-gold/25 text-[11px] font-bold text-gold-deep">
              {t("waiting.brand")}
            </span>
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
        ) : !rows || rows.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="flex flex-col gap-2.5">
            {rows.map((row, idx) => (
              <button
                key={row.facilityId}
                type="button"
                onClick={() =>
                  router.push(
                    `/explore/recommend?facilityId=${encodeURIComponent(row.facilityId)}&lat=${userLocation.lat}&lng=${userLocation.lng}`
                  )
                }
                className="group text-left w-full bg-white/90 border border-line rounded-2xl px-4 py-3.5 flex items-center gap-3 shadow-[0_2px_14px_rgba(43,35,32,0.06)] hover:border-gold/40 hover:bg-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
              >
                <span
                  className="w-9 h-9 shrink-0 rounded-full bg-gold/10 border border-gold/25 flex items-center justify-center text-base"
                  aria-hidden
                >
                  {TYPE_EMOJI[row.type] ?? "📍"}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-muk leading-snug truncate">{row.name}</p>
                  <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-gold/10 border border-gold/25 text-gold-deep whitespace-nowrap">
                      {t("waiting.arrivalWait", { n: Math.round(row.expectedWait) })}
                    </span>
                    {row.congestionLevel != null ? (
                      <span
                        className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md border whitespace-nowrap ${
                          row.congestionLevel >= 0.75
                            ? "bg-terracotta/10 border-terracotta/30 text-terracotta"
                            : row.congestionLevel >= 0.5
                            ? "bg-gold/10 border-gold/30 text-gold-deep"
                            : row.congestionLevel >= 0.25
                            ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-600"
                            : "bg-jade/10 border-jade/30 text-jade"
                        }`}
                      >
                        {t(`congestion.${congestionKey(row.congestionLevel)}`)}
                      </span>
                    ) : (
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md border bg-muk/5 border-line text-muk-soft whitespace-nowrap">
                        {t("card.noData")}
                      </span>
                    )}
                    {/* 골든타임 — 상위 5개 행만(연쇄 호출 최소화). 배지 자체도 available:false/실패면 스스로 숨는다. */}
                    {idx < GOLDEN_HOUR_TOP_N && <GoldenHourBadge facilityId={row.facilityId} />}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function BoardSkeleton() {
  return (
    <div className="flex flex-col gap-2.5" aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <div
          key={i}
          className="bg-white/70 border border-line rounded-2xl px-4 py-3.5 flex items-center gap-3 animate-pulse"
        >
          <div className="w-9 h-9 rounded-full bg-hanji-deep shrink-0" />
          <div className="flex-1 space-y-2">
            <div className="h-3.5 bg-hanji-deep rounded w-1/2" />
            <div className="h-3 bg-hanji-deep rounded w-1/3" />
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
