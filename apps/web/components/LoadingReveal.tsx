"use client";

// 프리미엄 로딩 연출 — /waiting·/course 가 백엔드 응답을 기다리는 동안 "빈 화면"이 아니라
// "일부러 준비 중"으로 읽히게 한다. 세 가지로 구성한다:
//   1) 진행 내레이션 — 가치 스토리를 담은 짧은 문장이 ~1.2초마다 넘어가고 마지막에서 멈춘다(i18n).
//   2) 스켈레톤 카드 — 실제 결과 카드 레이아웃과 대략 맞는 시머 플레이스홀더(빈 화면 방지).
//   3) 브랜드 모티프 — 은은히 맥동하는 NextSpot 핀.
// 로딩 전용 UI다: 가짜 결과·가짜 혼잡 수치를 만들지 않는다. 스켈레톤은 명백히 자리표시로 읽혀야 한다.
//
// 스타일은 globals.css 를 건드리지 않고 이 컴포넌트 안에서 자족한다(<style>). 토큰(hanji/gold/muk 등)만
// 쓰고, 시머·핀 맥동·문장 페이드는 전역 prefers-reduced-motion 규칙(globals.css)에 자동으로 눌린다.

import { useEffect, useState } from "react";
import { MapPin } from "lucide-react";
import { useT } from "@/lib/i18n/I18nProvider";

// "shared" 는 /course 의 공유 링크 복원 로딩(읽기 전용) 갈래다 — 같은 화면이라 여기서 함께 다룬다.
type Variant = "waiting" | "course" | "shared";

const STEP_COUNT = 3;
const STEP_INTERVAL_MS = 1200;

// 토큰 기반 시머 + 핀 맥동 + 문장 페이드. 하이라이트는 흰빛 저알파라 라이트/야간 표면 모두에서 은은하다.
const LOADER_STYLES = `
@keyframes ns-shimmer-slide { 100% { transform: translateX(100%); } }
.ns-skel { position: relative; overflow: hidden; }
.ns-skel::after {
  content: "";
  position: absolute;
  inset: 0;
  transform: translateX(-100%);
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.42), transparent);
  animation: ns-shimmer-slide 1.6s ease-in-out infinite;
}
@keyframes ns-pin-pulse {
  0% { transform: scale(0.9); opacity: 0.6; }
  70% { transform: scale(2); opacity: 0; }
  100% { transform: scale(2); opacity: 0; }
}
.ns-pin-ring { animation: ns-pin-pulse 2.1s cubic-bezier(0.2, 0, 0, 1) infinite; }
@keyframes ns-line-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
.ns-line-in { animation: ns-line-in 0.4s ease-out; }
/* 비선형 진행 바 — 지각 심리: 초반 ~2초에 74%까지 급가속해 "거의 다 됐다"로 읽히게 하고,
   이후 94%까지 아주 천천히 긴다. 100%에 도달하지 않아 "다 됐는데 왜 안 뜨지"를 만들지 않는다. */
@keyframes ns-progress {
  0% { width: 0%; }
  4% { width: 46%; }
  9% { width: 68%; }
  16% { width: 76%; }
  100% { width: 94%; }
}
.ns-progress { animation: ns-progress 28s cubic-bezier(0.25, 0.6, 0.35, 1) forwards; }
/* 블러 고스트 — '서버 로딩'이 아니라 '초점을 맞추는 렌즈'로 읽히게, 실제 카드와 같은 색·구조의
   콘텐츠 실루엣을 강한 블러 아래 숨쉬듯 보여준다. 글자는 한 글자도 없다(가짜 정보 0) —
   색면과 형태만으로 "내용이 이미 있다"는 인상을 만든다. reduced-motion 시 정지 블러(무해). */
@keyframes ns-focus-breathe {
  0%, 100% { filter: blur(9px) saturate(0.92); }
  50% { filter: blur(6px) saturate(1); }
}
.ns-ghost {
  animation: ns-focus-breathe 2.6s ease-in-out infinite;
  filter: blur(8px);
  opacity: 0.75;
  pointer-events: none;
  user-select: none;
}
`;

// 내레이션을 ~1.2초마다 한 단계씩 진행하고 마지막 문장에서 멈춘다(백엔드가 빠르면 잠깐만 스친다).
function useNarrationStep() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (step >= STEP_COUNT - 1) return; // 마지막 문장에서 정지 — 무한 순환하지 않는다.
    const timer = setTimeout(
      () => setStep((current) => Math.min(current + 1, STEP_COUNT - 1)),
      STEP_INTERVAL_MS,
    );
    return () => clearTimeout(timer);
  }, [step]);
  return step;
}

// 브랜드 헤더 — 맥동하는 핀 + 브랜드 + 액션 제목 + 진행 내레이션 + 3단계 진행 바.
function NarrationHeader({ variant }: { variant: Variant }) {
  const t = useT();
  const step = useNarrationStep();
  return (
    <section
      className="relative overflow-hidden rounded-2xl border border-gold/25 bg-white/90 px-5 py-5 shadow-[0_8px_30px_rgba(43,35,32,0.08)]"
      role="status"
      aria-live="polite"
    >
      <div className="absolute -right-10 -top-12 h-32 w-32 rounded-full bg-gold/15 blur-2xl" aria-hidden />
      <div className="relative flex items-center gap-3.5">
        {/* 브랜드 모티프 — NextSpot 핀 뒤로 은은히 번지는 맥동 링(장식이라 reduced-motion 시 숨김). */}
        <div className="relative grid h-12 w-12 shrink-0 place-items-center" aria-hidden>
          <span className="absolute inset-0 rounded-full border-2 border-gold/45 ns-pin-ring motion-reduce:hidden" />
          <span className="grid h-11 w-11 place-items-center rounded-full bg-gold/10 text-gold-deep shadow-[0_2px_10px_rgba(193,154,62,0.25)]">
            <MapPin size={22} strokeWidth={2.3} />
          </span>
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-wide text-gold-deep">NextSpot</p>
          <p className="text-sm font-bold text-muk leading-snug">{t(`loadingReveal.${variant}.title`)}</p>
          {/* key={step} 로 문장이 넘어갈 때마다 짧은 페이드를 다시 태운다. */}
          <p key={step} className="ns-line-in mt-0.5 text-xs text-muk-soft leading-snug">
            {t(`loadingReveal.${variant}.step${step + 1}`)}
          </p>
        </div>
      </div>
      {/* 비선형 진행 바 — 초반 급가속 후 94%까지 크롤(위 ns-progress 주석 참조). reduced-motion 시
          애니메이션이 전역 규칙으로 눌려 마지막 프레임(94%) 근처로 고정된다 — 정지 상태로도 무해. */}
      <div className="relative mt-4 h-1.5 w-full overflow-hidden rounded-full bg-line" aria-hidden>
        <span className="ns-progress block h-full rounded-full bg-gold" />
      </div>
    </section>
  );
}

// /waiting 결과 레이아웃 미러 — 유형 섹터(대표 포트레이트 카드 3장 + 컴팩트 행)를 두 벌 시머로 채운다.
function WaitingSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden>
      {[0, 1].map((sector) => (
        <div key={sector} className="space-y-2">
          <div className="ns-skel h-4 w-24 rounded bg-hanji-deep" />
          <div className="grid grid-cols-3 gap-2">
            {[0, 1, 2].map((card) => (
              <div
                key={card}
                className="flex h-64 flex-col overflow-hidden rounded-2xl border border-line bg-white/80 shadow-[0_2px_14px_rgba(43,35,32,0.06)]"
              >
                {/* 렌즈 초점 고스트 — 실제 카드의 색·구조(사진·제목·배지·점수)를 블러 아래 실루엣으로.
                    글자 0개(가짜 정보 없음), 형태와 색만. */}
                <div className="ns-ghost flex h-full flex-col">
                  <div className="ns-skel h-24 w-full bg-gradient-to-br from-hanji-deep via-gold/25 to-jade/20" />
                  <div className="flex flex-1 flex-col gap-1.5 p-2">
                    <div className="h-3 w-11/12 rounded bg-muk/45" />
                    <div className="h-2.5 w-3/5 rounded bg-muk/25" />
                    <div className="flex gap-1">
                      <span className="h-3.5 w-10 rounded-md bg-jade/35" />
                      <span className="h-3.5 w-12 rounded-md bg-gold/40" />
                    </div>
                    <div className="mt-auto space-y-1.5">
                      <div className="h-3.5 w-3/4 rounded bg-muk/30" />
                      <div className="h-5 w-14 rounded-md border border-gold/40 bg-gold/25" />
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-2">
            {[0, 1].map((row) => (
              <div
                key={row}
                className="flex items-center gap-2.5 rounded-2xl border border-line bg-white/80 px-3.5 py-2.5 shadow-[0_2px_14px_rgba(43,35,32,0.06)]"
              >
                <div className="ns-ghost flex flex-1 items-center gap-2.5">
                  <div className="h-7 w-7 shrink-0 rounded-full bg-gold/30" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3.5 w-1/2 rounded bg-muk/40" />
                    <div className="flex gap-1.5">
                      <span className="h-3 w-16 rounded-md bg-gold/35" />
                      <span className="h-3 w-12 rounded-md bg-jade/30" />
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// /course 결과 레이아웃 미러 — 가로 스텝퍼 + 정류지 행 목록(StopRows 컨테이너와 같은 여백·구분선).
function CourseBodySkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden>
      <div className="ns-ghost flex items-start gap-3">
        {[0, 1, 2].map((step) => (
          <div key={step} className="flex flex-1 flex-col items-center gap-1.5">
            <div className="h-8 w-8 rounded-full border-2 border-gold/50 bg-gold/25" />
            <div className="h-2 w-10 rounded bg-muk/30" />
          </div>
        ))}
      </div>
      <div className="-mx-4 divide-y divide-line md:-mx-6">
        {[0, 1, 2].map((row) => (
          <div key={row} className="px-4 py-4 md:px-6">
            <div className="ns-ghost flex items-start gap-3">
              <div className="h-9 w-9 shrink-0 rounded-full bg-gold/30" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="h-4 w-1/2 rounded bg-muk/40" />
                  <div className="h-4 w-14 rounded-lg border border-gold/40 bg-gold/20" />
                </div>
                <div className="flex gap-1.5">
                  <span className="h-3 w-20 rounded bg-muk/25" />
                  <span className="h-3 w-14 rounded-md bg-jade/30" />
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function LoadingReveal({ variant }: { variant: Variant }) {
  return (
    <div className="flex flex-col gap-6">
      <style>{LOADER_STYLES}</style>
      <NarrationHeader variant={variant} />
      {variant === "waiting" ? <WaitingSkeleton /> : <CourseBodySkeleton />}
    </div>
  );
}
