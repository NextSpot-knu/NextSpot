"use client";

// 분산 코스(멀티스톱 동선) 추천 페이지.
// 백엔드 POST /api/v1/courses/recommend 가 '도착 시각의 예측 혼잡'을 피해 2~3개 정류지로
// 이어지는 동선을 짜준다. 이 페이지는 세션/위치를 얻어 호출하고, 결과를 세로 타임라인으로 그린다.
// 정적 export(SSR) 안전: 모든 브라우저 API 접근은 useEffect/핸들러 내부에 둔다.

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { createPublicClient } from "@/lib/supabase";
import { apiClient } from "@/lib/api-client";
import { REGION, isWithinRegion } from "@/lib/region";

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
}

const TYPE_OPTIONS = [
  { id: "restaurant", label: "음식점", emoji: "🍴" },
  { id: "cafe", label: "카페", emoji: "☕" },
  { id: "attraction", label: "관광지", emoji: "📸" },
  { id: "culture", label: "문화시설", emoji: "🏛️" },
];

function typeName(type: string): string {
  return TYPE_OPTIONS.find((t) => t.id === type)?.label ?? "장소";
}

function typeEmoji(type: string): string {
  return TYPE_OPTIONS.find((t) => t.id === type)?.emoji ?? "📍";
}

// 혼잡 라벨/색 — 백엔드 _congestion_label 임계값과 통일.
function congestion(level: number): { label: string; cls: string } {
  if (level >= 0.75) return { label: "혼잡", cls: "text-terracotta bg-terracotta/10 border-terracotta/25" };
  if (level >= 0.5) return { label: "보통", cls: "text-gold-deep bg-gold/10 border-gold/25" };
  if (level >= 0.25) return { label: "여유", cls: "text-jade bg-jade/10 border-jade/25" };
  return { label: "한산", cls: "text-jade bg-jade/15 border-jade/30" };
}

// 도착 오프셋(분) → 사람 친화 표기 + 예상 시각(HH:MM).
function arrivalText(offsetMin: number): string {
  const clock = new Date(Date.now() + offsetMin * 60_000);
  const hh = clock.getHours().toString().padStart(2, "0");
  const mm = clock.getMinutes().toString().padStart(2, "0");
  if (offsetMin < 8) return `지금 바로 · ${hh}:${mm}`;
  return `약 ${Math.round(offsetMin)}분 뒤 · ${hh}:${mm}`;
}

export default function CoursePage() {
  const [userId, setUserId] = useState<string | null>(null);
  const [coords, setCoords] = useState<{ lat: number; lng: number }>({
    lat: REGION.center.lat,
    lng: REGION.center.lng,
  });
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const [stops, setStops] = useState<CourseStop[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 1) 세션(사용자 ID) — 없으면 데모 방문자로 폴백.
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? MOCK_VISITOR_ID);
    });
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
        /* 권한 거부/실패 → 지역 중심 기본값 유지 */
      }
    );
  }, []);

  // 3) 코스 조회.
  const fetchCourse = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        userId,
        userLat: coords.lat,
        userLng: coords.lng,
      };
      if (selectedTypes.length > 0) body.types = selectedTypes;
      const data: CourseStop[] = await apiClient.post("/api/v1/courses/recommend", body);
      setStops(Array.isArray(data) ? data : []);
    } catch (err) {
      console.warn("코스 추천 호출 실패:", err);
      setError("추천 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.");
      setStops([]);
    } finally {
      setLoading(false);
    }
  }, [userId, coords.lat, coords.lng, selectedTypes]);

  useEffect(() => {
    fetchCourse();
  }, [fetchCourse]);

  const toggleType = (id: string) => {
    setSelectedTypes((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  };

  return (
    <main className="min-h-screen bg-hanji text-muk relative overflow-hidden">
      {/* 배경 노을·금빛 광원 */}
      <div className="absolute top-[-20%] left-[-10%] w-[520px] h-[520px] rounded-full bg-sunset-1/10 blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[520px] h-[520px] rounded-full bg-gold/10 blur-[120px] pointer-events-none" />

      <div className="relative z-10 mx-auto w-full max-w-md md:max-w-2xl px-4 md:px-6 py-6 space-y-6">
        {/* 헤더 */}
        <header className="flex items-center justify-between border-b border-line pb-4">
          <Link
            href="/main"
            className="text-xs text-muk-soft hover:text-muk transition-colors flex items-center gap-1.5"
          >
            ← 지도 보기
          </Link>
          <span className="text-sm font-extrabold tracking-tight gradient-text">NextSpot 분산 코스</span>
          <div className="w-14" />
        </header>

        {/* 소개 */}
        <section className="space-y-1.5">
          <h1 className="text-lg md:text-xl font-serif font-bold text-muk">
            혼잡을 피해 도는 <span className="text-gold-deep">맞춤 동선</span>
          </h1>
          <p className="text-xs md:text-sm text-muk-soft leading-relaxed">
            각 정류지에 <span className="font-semibold text-jade">도착하는 시각</span>의 예측 혼잡을 피하도록
            2~3곳을 이어 드려요. 이동·체류 시간을 반영한 정직한 추천입니다.
          </p>
        </section>

        {/* 종류 필터 */}
        <section className="flex flex-wrap gap-2">
          {TYPE_OPTIONS.map((t) => {
            const on = selectedTypes.includes(t.id);
            return (
              <button
                key={t.id}
                onClick={() => toggleType(t.id)}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
                  on
                    ? "bg-gold/15 border-gold/40 text-gold-deep"
                    : "bg-white border-line text-muk-soft hover:border-gold/30"
                }`}
              >
                {t.emoji} {t.label}
              </button>
            );
          })}
        </section>

        {/* 본문 상태 */}
        {loading ? (
          <TimelineSkeleton />
        ) : error ? (
          <ErrorState message={error} onRetry={fetchCourse} />
        ) : stops.length === 0 ? (
          <EmptyState />
        ) : (
          <Timeline stops={stops} />
        )}
      </div>
    </main>
  );
}

function Timeline({ stops }: { stops: CourseStop[] }) {
  return (
    <ol className="relative space-y-4">
      {stops.map((stop, idx) => {
        const cong = congestion(stop.predictedCongestion);
        const isLast = idx === stops.length - 1;
        return (
          <li key={stop.facility.id} className="relative pl-11">
            {/* 세로 연결선 */}
            {!isLast && (
              <span className="absolute left-[19px] top-9 bottom-[-1rem] w-px bg-gradient-to-b from-gold/50 to-line" aria-hidden />
            )}
            {/* 순서 노드 */}
            <span className="absolute left-0 top-1 flex items-center justify-center w-10 h-10 rounded-full bg-gold text-white font-bold text-sm shadow-[0_2px_10px_rgba(193,154,62,0.35)]">
              {stop.order}
            </span>

            <div className="bg-white rounded-2xl border border-line shadow-[0_2px_14px_rgba(43,35,32,0.06)] p-4 space-y-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[10px] font-bold tracking-wider text-muk-soft">
                    {typeEmoji(stop.facility.type)} {typeName(stop.facility.type)}
                  </div>
                  <h3 className="text-base font-serif font-bold text-muk truncate">
                    {stop.facility.name}
                  </h3>
                </div>
                <span
                  className={`shrink-0 px-2 py-1 rounded-lg text-[11px] font-bold border ${cong.cls}`}
                >
                  {cong.label} {Math.round(stop.predictedCongestion * 100)}%
                </span>
              </div>

              <div className="flex items-center gap-2 text-[11px] text-muk-soft">
                <span className="inline-flex items-center gap-1">
                  🕒 {arrivalText(stop.arrivalOffsetMin)}
                </span>
                <span className="text-line">·</span>
                <span className="inline-flex items-center gap-1">
                  SPOT {Math.round(stop.spotScore * 100)}점
                </span>
              </div>

              <p className="text-xs text-muk leading-relaxed bg-hanji-deep/60 rounded-lg px-3 py-2">
                {stop.reason}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function TimelineSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      {[0, 1, 2].map((i) => (
        <div key={i} className="relative pl-11">
          <span className="absolute left-0 top-1 w-10 h-10 rounded-full bg-hanji-deep animate-pulse" />
          <div className="bg-white rounded-2xl border border-line p-4 space-y-3 animate-pulse">
            <div className="h-4 bg-hanji-deep w-2/3 rounded-md" />
            <div className="h-3 bg-hanji-deep w-1/2 rounded-md" />
            <div className="h-8 bg-hanji-deep w-full rounded-lg" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="bg-white rounded-2xl border border-line shadow-[0_2px_14px_rgba(43,35,32,0.06)] p-8 text-center space-y-2">
      <div className="text-3xl">🗺️</div>
      <p className="text-sm font-semibold text-muk">추천할 코스를 찾지 못했어요</p>
      <p className="text-xs text-muk-soft leading-relaxed">
        근처에 조건에 맞는 장소가 부족해요. 종류 필터를 넓히거나 잠시 후 다시 시도해 주세요.
      </p>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="bg-white rounded-2xl border border-terracotta/25 shadow-[0_2px_14px_rgba(43,35,32,0.06)] p-8 text-center space-y-3">
      <div className="text-3xl">⚠️</div>
      <p className="text-sm font-semibold text-muk">{message}</p>
      <button
        onClick={onRetry}
        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-gold text-white text-xs font-bold hover:bg-gold-deep transition-colors"
      >
        다시 시도
      </button>
    </div>
  );
}
