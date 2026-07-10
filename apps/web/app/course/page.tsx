"use client";

// 분산 코스(멀티스톱 동선) 추천 페이지.
// 백엔드 POST /api/v1/courses/recommend 가 '도착 시각의 예측 혼잡'을 피해 2~3개 정류지로
// 이어지는 동선을 짜준다. 이 페이지는 세션/위치를 얻어 호출하고, 결과를 세로 타임라인으로 그린다.
// 정적 export(SSR) 안전: 모든 브라우저 API 접근은 useEffect/핸들러 내부에 둔다.

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { createPublicClient } from "@/lib/supabase";
import { apiClient, isAuthError } from "@/lib/api-client";
import { REGION, isWithinRegion } from "@/lib/region";
import { toast } from "sonner";
import { useT } from "@/lib/i18n/I18nProvider";
import { ShareButton } from "@/components/ShareButton";

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
}

const TYPE_OPTIONS = [
  { id: "restaurant", emoji: "🍴" },
  { id: "cafe", emoji: "☕" },
  { id: "attraction", emoji: "📸" },
  { id: "culture", emoji: "🏛️" },
];
const TYPE_IDS = TYPE_OPTIONS.map((o) => o.id);

// 시설 유형(캐노니컬 키) → 표시명(i18n category, 미지정은 폴백).
function typeName(type: string, t: TFunc): string {
  return TYPE_IDS.includes(type) ? t(`category.${type}`) : t("course.typeFallback");
}

function typeEmoji(type: string): string {
  return TYPE_OPTIONS.find((o) => o.id === type)?.emoji ?? "📍";
}

// 혼잡 키/색 — 백엔드 _congestion_label 임계값과 통일(라벨은 congestion 네임스페이스로 번역).
function congestion(level: number): { key: string; cls: string } {
  if (level >= 0.75) return { key: "busy", cls: "text-terracotta bg-terracotta/10 border-terracotta/25" };
  if (level >= 0.5) return { key: "moderate", cls: "text-gold-deep bg-gold/10 border-gold/25" };
  if (level >= 0.25) return { key: "relaxed", cls: "text-jade bg-jade/10 border-jade/25" };
  return { key: "quiet", cls: "text-jade bg-jade/15 border-jade/30" };
}

// 도착 오프셋(분) → 사람 친화 표기 + 예상 시각(HH:MM).
function arrivalText(offsetMin: number, t: TFunc): string {
  const clock = new Date(Date.now() + offsetMin * 60_000);
  const hh = clock.getHours().toString().padStart(2, "0");
  const mm = clock.getMinutes().toString().padStart(2, "0");
  if (offsetMin < 8) return `${t("course.arrivalNow")} · ${hh}:${mm}`;
  return `${t("course.arrivalAfter", { min: Math.round(offsetMin) })} · ${hh}:${mm}`;
}

export default function CoursePage() {
  const t = useT();
  const [userId, setUserId] = useState<string | null>(null);
  const [coords, setCoords] = useState<{ lat: number; lng: number }>({
    lat: REGION.center.lat,
    lng: REGION.center.lng,
  });
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const [stops, setStops] = useState<CourseStop[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);

  // 1) 세션(사용자 ID) — SessionBootstrap 익명 세션이 잡히면 실제 per-device id, 없으면 데모 방문자로 폴백.
  useEffect(() => {
    supabase.auth
      .getSession()
      .then(({ data: { session } }) => {
        setUserId(session?.user?.id ?? MOCK_VISITOR_ID);
      })
      .catch(() => {
        // 인증 서버 미도달 등 → 데모 방문자로 폴백(성공 경로의 세션 없음과 동일).
        setUserId(MOCK_VISITOR_ID);
      });

    // 익명 세션이 뒤늦게 부트스트랩되면 실제 id 로 승격 → fetchCourse 재실행. body user_id 와 첨부 토큰이
    // 같은 세션에서 나오므로 백엔드 IDOR 가드(req.user_id == JWT sub)와 정합하게 유지된다.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) setUserId(session.user.id);
    });
    return () => { subscription?.unsubscribe?.(); };
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

  // 3) 코스 조회.
  const fetchCourse = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    setNeedsAuth(false);
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
      setStops([]);
      // 401(인증 필요)은 서버 장애가 아니다 → 성공할 수 없는 '다시 시도' 대신 정직한 안내.
      if (isAuthError(err)) {
        setNeedsAuth(true);
      } else {
        setError(t("course.fetchError"));
      }
    } finally {
      setLoading(false);
    }
  }, [userId, coords.lat, coords.lng, selectedTypes, t]);

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
            ← {t('course.backToMap')}
          </Link>
          <span className="text-sm font-extrabold tracking-tight gradient-text">{t('course.brand')}</span>
          <ShareButton title={t('course.title')} text={t('common.shareCourse')} />
        </header>

        {/* 소개 */}
        <section className="space-y-1.5">
          <h1 className="text-lg md:text-xl font-serif font-bold text-muk">
            {t('course.title')}
          </h1>
          <p className="text-xs md:text-sm text-muk-soft leading-relaxed">
            {t('course.desc')}
          </p>
        </section>

        {/* 종류 필터 */}
        <section className="flex flex-wrap gap-2">
          {TYPE_OPTIONS.map((opt) => {
            const on = selectedTypes.includes(opt.id);
            return (
              <button
                key={opt.id}
                onClick={() => toggleType(opt.id)}
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
        </section>

        {/* 본문 상태 */}
        {loading ? (
          <TimelineSkeleton />
        ) : needsAuth ? (
          <AuthState />
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
  const t = useT();
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
                    {typeEmoji(stop.facility.type)} {typeName(stop.facility.type, t)}
                  </div>
                  <h3 className="text-base font-serif font-bold text-muk truncate">
                    {stop.facility.name}
                  </h3>
                </div>
                <span
                  className={`shrink-0 px-2 py-1 rounded-lg text-[11px] font-bold border ${cong.cls}`}
                >
                  {t(`congestion.${cong.key}`)} {Math.round(stop.predictedCongestion * 100)}%
                </span>
              </div>

              <div className="flex items-center gap-2 text-[11px] text-muk-soft">
                <span className="inline-flex items-center gap-1">
                  🕒 {arrivalText(stop.arrivalOffsetMin, t)}
                </span>
                <span className="text-line">·</span>
                <span className="inline-flex items-center gap-1">
                  {t('course.spotScore', { score: Math.round(stop.spotScore * 100) })}
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
