'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { MYPAGE_BACK } from '@/lib/navigation';
import { ChevronLeft, Share2, Compass, Wind, Ticket, Clock, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { useT } from '@/lib/i18n/I18nProvider';

// 백엔드 GET /api/v1/impact/summary 응답(snake_case)을 api-client 가 camelCase 로 변환해 준다.
// '방문(visit_history)' 지표는 여기 없다 — apps/web/lib/visits.ts 의 localStorage 전용 데이터라
// 백엔드가 볼 수 없다(정직성 원칙). 백엔드가 실제로 DB 에서 파생한 지표만 내려온다.
interface ImpactSummary {
  accepted: number;
  congestionAvoided: number;
  couponsIssued: number;
  couponsUsed: number;
  waitSavedMinutes: number;
}

// 예시 값 — /mypage 최상단 요약 카드(components/ImpactSummaryCard.tsx)·관제 데모 콘솔과 같은 숫자다.
// 두 화면이 서로 다른 성과를 말하면 어느 쪽도 믿을 수 없다. 값을 바꾸면 세 곳을 함께 바꿀 것.
const SAMPLE_SUMMARY: ImpactSummary = {
  accepted: 312,
  congestionAvoided: 268,
  couponsIssued: 196,
  couponsUsed: 138,
  waitSavedMinutes: 1240,
};
/** 참여 점포 수 — 임팩트 API 계약(ImpactSummaryResponse 5필드)에 없는 항목이라 언제나 예시 값이다. */
const SAMPLE_PARTICIPATING_STORES = 14;

export default function ImpactPage() {
  const router = useRouter();
  const t = useT();
  const [summary, setSummary] = useState<ImpactSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // 예시 값 모드 — 비로그인(401)·서버 미가용·신규 사용자(전부 0)일 때 켜진다.
  // 화면은 빈손 대신 예시 숫자를 보여주되 '실증 준비 중 · 예시 값' 배지를 항상 함께 띄운다.
  // (종전에는 여기서 에러/빈 화면으로 떨어져, /mypage 의 '여행 임팩트' 항목이 사실상 아무것도
  //  열지 못했다 — 2026-09-21 라이브 실측.)
  const [isSample, setIsSample] = useState(false);

  // 임팩트 요약 조회 — 마운트 effect 와 에러 상태의 '다시 시도' 버튼이 함께 재사용한다.
  // api-client 의 요청 타임아웃(10초)이 무한 스켈레톤을 막아준다(coupons 페이지와 동일 패턴).
  // 세션 부트스트랩 유예 자동 재시도 1회 플래그(catch 블록 참조)
  const retriedRef = useRef(false);
  const fetchSummary = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await apiClient.get('/api/v1/impact/summary');
      const next: ImpactSummary = {
        accepted: Number(data?.accepted) || 0,
        congestionAvoided: Number(data?.congestionAvoided) || 0,
        couponsIssued: Number(data?.couponsIssued) || 0,
        couponsUsed: Number(data?.couponsUsed) || 0,
        waitSavedMinutes: Number(data?.waitSavedMinutes) || 0,
      };
      // 신규 사용자(전부 0)는 보여 줄 성과가 없다 — 빈 화면 대신 예시 값 + 배지.
      const empty =
        next.accepted === 0 &&
        next.congestionAvoided === 0 &&
        next.couponsIssued === 0 &&
        next.waitSavedMinutes === 0;
      setIsSample(empty);
      setSummary(empty ? SAMPLE_SUMMARY : next);
      setIsLoading(false);
    } catch (err) {
      // 인증 필요(401)든 서버 미가용이든 결과는 같다: 예시 값 + '실증 준비 중' 배지.
      // 단 첫 실패는 익명 세션 부트스트랩(SessionBootstrap) 완료 전 레이스일 수 있어(실측 재현)
      // 2.5초 유예 후 자동 1회만 재시도 — 유한 재시도라 무한 스켈레톤 아님.
      console.warn('Failed to fetch impact summary', err);
      if (!retriedRef.current) {
        retriedRef.current = true;
        setTimeout(() => { void fetchSummary(); }, 2500);
        return; // isLoading 유지(스켈레톤)
      }
      setIsSample(true);
      setSummary(SAMPLE_SUMMARY);
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSummary();
  }, [fetchSummary]);


  // 공유 — Web Share API 우선, 미지원/실패 시 클립보드 복사 + 토스트로 폴백.
  const handleShare = useCallback(async () => {
    if (!summary) return;
    const shareText = t('impact.shareText', {
      accepted: String(summary.accepted),
      congestionAvoided: String(summary.congestionAvoided),
      couponsIssued: String(summary.couponsIssued),
    });
    const shareUrl = typeof window !== 'undefined' ? window.location.origin : 'https://nextspot.app';

    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: t('impact.shareTitle'), text: shareText, url: shareUrl });
        return;
      } catch (err) {
        // 사용자가 공유 시트를 취소한 경우(AbortError)는 실패가 아니므로 조용히 종료.
        if (err instanceof Error && err.name === 'AbortError') return;
        console.warn('navigator.share failed, falling back to clipboard', err);
      }
    }
    try {
      await navigator.clipboard.writeText(`${shareText}\n${shareUrl}`);
      toast.success(t('impact.shareCopied'));
    } catch (err) {
      console.warn('clipboard copy failed', err);
      toast.error(t('impact.shareCopyFail'));
    }
  }, [summary, t]);

  return (
    <div className="relative w-full h-[100dvh] bg-hanji flex flex-col overflow-hidden">

      {/* 헤더 */}
      <header className="flex items-center gap-3 p-5 z-10 relative">
        <button
          type="button"
          aria-label={t('impact.backAria')}
          // 목적지를 못박는다 — 딥링크·새로고침이면 back() 은 죽는다(MYPAGE_BACK 주석).
          onClick={() => router.push(MYPAGE_BACK)}
          className="text-muk-soft hover:text-muk transition-colors"
        >
          <ChevronLeft size={24} />
        </button>
        <h1 className="text-xl font-bold font-serif text-muk tracking-wide">{t('impact.pageTitle')}</h1>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col relative z-10 px-6 overflow-y-auto pb-[calc(var(--tourist-nav-clearance)+env(safe-area-inset-bottom))] md:pb-6 no-scrollbar">
        {isLoading ? (
          // 공유 카드 형태의 스켈레톤(스피너 대체) — 유한 로딩(요청 타임아웃 시 에러 상태로 전환).
          <div className="flex flex-col mt-2 md:max-w-md md:mx-auto md:w-full" aria-hidden>
            <div className="bg-white border border-line rounded-3xl p-8 shadow-[0_2px_14px_rgba(43,35,32,0.06)] animate-pulse">
              <div className="h-3 bg-hanji-deep w-1/4 rounded-md mx-auto mb-4" />
              <div className="h-6 bg-hanji-deep w-2/3 rounded-md mx-auto mb-8" />
              <div className="grid grid-cols-2 gap-3 mb-6">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="h-24 bg-hanji-deep rounded-2xl" />
                ))}
              </div>
              <div className="h-4 bg-hanji-deep w-1/2 rounded-md mx-auto" />
            </div>
          </div>
        ) : summary ? (
          // 공유 카드 — 지표 타일은 백엔드가 실제로 준 것만(방문 타일 없음 — 위 인터페이스 주석 참고).
          <div className="flex flex-col items-center mt-2 md:max-w-md md:mx-auto md:w-full animate-fade-in">
            {/* 헤드라인 3종 — /mypage 최상단 카드가 보여준 바로 그 세 숫자의 상세다.
                (요약 카드를 탭해서 온 사람이 같은 숫자를 다시 만나야 '상세로 들어왔다'가 성립한다.) */}
            <div className="mb-4 w-full rounded-3xl border border-gold/35 bg-gradient-to-r from-gold/15 via-hanji to-jade/10 p-5 shadow-[0_2px_14px_rgba(43,35,32,0.06)]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 text-[13px] font-bold text-muk">
                  <Sparkles size={16} className="text-gold-deep" aria-hidden="true" />
                  {t('impact.summaryTitle')}
                </span>
                {/* 예시 값임을 숨기지 않는다 — 배지가 없으면 실집계로 오인된다. */}
                {isSample && (
                  <span className="rounded-full border border-terracotta/30 bg-terracotta/10 px-2 py-0.5 text-[10px] font-bold text-terracotta">
                    {t('impact.sampleBadge')}
                  </span>
                )}
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {[
                  t('impact.summaryDispersals', { n: summary.accepted.toLocaleString() }),
                  t('impact.summarySavedWait', { n: summary.waitSavedMinutes.toLocaleString() }),
                  t('impact.summaryStores', { n: SAMPLE_PARTICIPATING_STORES.toLocaleString() }),
                ].map((text) => (
                  <span
                    key={text}
                    className="min-w-0 break-keep rounded-2xl border border-line bg-white/70 px-2 py-2.5 text-center text-[13px] font-black text-muk tabular-nums"
                  >
                    {text}
                  </span>
                ))}
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-muk-soft">
                {isSample ? t('impact.summarySampleNote') : t('impact.summaryRealNote')}
              </p>
            </div>
            <div className="relative w-full bg-white border border-gold/30 rounded-3xl p-8 shadow-[0_8px_32px_rgba(43,35,32,0.10)] overflow-hidden">
              {/* 은은한 금빛 광원 */}
              <div className="absolute -top-10 -right-10 w-40 h-40 bg-gold/15 rounded-full blur-[60px] pointer-events-none" aria-hidden="true" />

              {/* 대릉원 능선 실루엣(장식) — app/page.tsx 랜딩 모티브를 카드 크기로 재구성(장식 전용). */}
              <svg
                viewBox="0 0 400 100"
                preserveAspectRatio="xMidYMax slice"
                className="absolute bottom-0 inset-x-0 w-full h-16 pointer-events-none"
                aria-hidden="true"
              >
                <path d="M-20 100 Q 80 30 180 100 Z" fill="var(--color-jade)" fillOpacity="0.08" />
                <path d="M140 100 Q 260 15 380 100 Z" fill="var(--color-jade)" fillOpacity="0.08" />
                <path d="M-40 100 Q 40 45 130 100 Z" fill="var(--color-jade)" fillOpacity="0.13" />
                <path d="M250 100 Q 340 35 440 100 Z" fill="var(--color-jade)" fillOpacity="0.13" />
              </svg>

              <div className="relative z-10 flex flex-col items-center text-center">
                <p className="text-xs font-semibold text-gold-deep tracking-widest uppercase mb-2">NextSpot</p>
                <h2 className="text-2xl font-bold font-serif text-muk mb-1">{t('impact.cardTitle')}</h2>
                <p className="text-xs text-muk-soft mb-6">{t('impact.cardSubtitle')}</p>

                {/* 지표 타일 */}
                <div className="grid grid-cols-2 gap-3 w-full mb-6">
                  <div className="min-w-0 w-full flex flex-col items-center gap-1.5 bg-hanji rounded-2xl border border-line p-4">
                    <Compass size={20} className="text-terracotta" aria-hidden="true" />
                    <span className="w-full min-w-0 text-xl font-bold text-muk break-words text-center">
                      {t('impact.tileAcceptedValue', { n: String(summary.accepted) })}
                    </span>
                    <span className="w-full min-w-0 text-[11px] text-muk-soft font-medium text-center break-words">
                      {t('impact.metricAccepted')}
                    </span>
                  </div>
                  <div className="min-w-0 w-full flex flex-col items-center gap-1.5 bg-hanji rounded-2xl border border-line p-4">
                    <Wind size={20} className="text-jade" aria-hidden="true" />
                    <span className="w-full min-w-0 text-xl font-bold text-muk break-words text-center">
                      {t('impact.tileCongestionAvoidedValue', { n: String(summary.congestionAvoided) })}
                    </span>
                    <span className="w-full min-w-0 text-[11px] text-muk-soft font-medium text-center break-words">
                      {t('impact.metricCongestionAvoided')}
                    </span>
                  </div>
                  <div className="min-w-0 w-full flex flex-col items-center gap-1.5 bg-hanji rounded-2xl border border-line p-4">
                    <Ticket size={20} className="text-gold-deep" aria-hidden="true" />
                    <span className="w-full min-w-0 text-xl font-bold text-muk break-words text-center">
                      {t('impact.tileCouponsIssuedValue', { n: String(summary.couponsIssued) })}
                    </span>
                    <span className="w-full min-w-0 text-[11px] text-muk-soft font-medium text-center break-words">
                      {t('impact.metricCouponsIssued')}
                      {summary.couponsUsed > 0 && (
                        <> · {t('impact.metricCouponsUsedInline', { n: String(summary.couponsUsed) })}</>
                      )}
                    </span>
                  </div>
                  <div className="min-w-0 w-full flex flex-col items-center gap-1.5 bg-hanji rounded-2xl border border-line p-4">
                    <Clock size={20} className="text-muk-soft" aria-hidden="true" />
                    <span className="w-full min-w-0 text-xl font-bold text-muk break-words text-center">
                      {t('impact.tileWaitSavedValue', { n: String(summary.waitSavedMinutes) })}
                    </span>
                    <span className="w-full min-w-0 text-[11px] text-muk-soft font-medium text-center break-words">
                      {t('impact.metricWaitSaved')}
                    </span>
                  </div>
                </div>

                <p className="text-sm text-muk font-medium leading-relaxed">{t('impact.moodCopy')}</p>
              </div>
            </div>

            {/* 공유 버튼 */}
            <button
              type="button"
              onClick={() => void handleShare()}
              className="mt-6 w-full flex items-center justify-center gap-2 py-4 rounded-2xl bg-gold hover:bg-gold-deep text-white font-semibold transition-colors"
            >
              <Share2 size={18} />
              <span>{t('impact.shareButton')}</span>
            </button>
          </div>
        ) : null}
      </main>
    </div>
  );
}
