'use client';

import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { MYPAGE_BACK } from '@/lib/navigation';
import { ChevronLeft, Share2, Compass, Wind, Ticket, Clock, Sparkles, MapPin } from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { useT } from '@/lib/i18n/I18nProvider';
import { readImpactSummary, type ImpactSummary } from '@/lib/impactSummary';
import { useRegion } from '@/lib/regionContext';

// 백엔드 GET /api/v1/impact/summary 응답(snake_case)을 api-client 가 camelCase 로 변환해 주고, lib/impactSummary 가
// 화면이 쓸 숫자로 읽는다. '방문(visit_history)' 지표는 여기 없다 — apps/web/lib/visits.ts 의 localStorage 전용
// 데이터라 백엔드가 볼 수 없다. 서버가 아는 도착은 사용자가 '도착했어요' 를 누른 기록(도착 확인)뿐이다.
//
// 타일은 **근거가 있는 값만** 그린다(P0-5 b). 출발·도착 확인은 실제로 센 값이라 0 이어도 그린다(도착 확인은 서버가
// 세지 못했으면 뺀다). 혼잡 회피·줄인 예상 대기·쿠폰은 0 이면 그리지 않는다 — /main 수락에는 원래 장소와의 비교가 없어
// 늘 '아낀 대기 0분' 이 붙었고, 그 0 에 "덜 기다린 만큼, 더 여행하셨어요" 같은 칭찬 문구가 따라붙었다.

// 숫자는 천 단위 구분(1,240분) — 요약 카드·타일·공유 문구가 같은 모양이어야 한다.
const fmt = (n: number) => n.toLocaleString();

export default function ImpactPage() {
  const router = useRouter();
  const t = useT();
  // 지역(S3) — 공유가 꺼진 지역(내부 검증 지역: 받는 사람이 볼 수 없다)에서는 공유 버튼을 그리지 않고, 카드 제목도 경주가
  // 아니라 그 지역 이름으로 말한다. 경주는 오늘과 같다.
  const { pack, isPublic, regionName } = useRegion();
  const canShare = pack.features.share;
  const [summary, setSummary] = useState<ImpactSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // 시작 상태 — 비로그인(401)·서버 미가용·신규 사용자(센 기록 없음)일 때 켜진다. 숫자 대신 '추천받은 곳으로
  // 출발하면 여기에 기록이 쌓여요' 와 지도로 가는 버튼을 보여 준다. 예전에는 관제 데모의 예시 숫자를
  // '나의 경주 여행 임팩트' 로 보여 주고 공유까지 열어 뒀다 — 지어낸 기록으로 읽혔다(2026-10-06 감사 I18).
  const [isEmpty, setIsEmpty] = useState(false);

  // 임팩트 요약 조회 — 마운트 effect 와 에러 상태의 '다시 시도' 버튼이 함께 재사용한다.
  // api-client 의 요청 타임아웃(10초)이 무한 스켈레톤을 막아준다(coupons 페이지와 동일 패턴).
  // 세션 부트스트랩 유예 자동 재시도 1회 플래그(catch 블록 참조)
  const retriedRef = useRef(false);
  const fetchSummary = useCallback(async () => {
    setIsLoading(true);
    try {
      const next = readImpactSummary(await apiClient.get('/api/v1/impact/summary'));
      // 신규 사용자(센 기록이 없다)는 보여 줄 것이 없다 — 시작 상태로.
      setIsEmpty(!next.hasRecord);
      setSummary(next.hasRecord ? next : null);
      setIsLoading(false);
    } catch (err) {
      // 인증 필요(401)든 서버 미가용이든 결과는 같다: 시작 상태(숫자를 지어내지 않는다).
      // 단 첫 실패는 익명 세션 부트스트랩(SessionBootstrap) 완료 전 레이스일 수 있어(실측 재현)
      // 2.5초 유예 후 자동 1회만 재시도 — 유한 재시도라 무한 스켈레톤 아님.
      console.warn('Failed to fetch impact summary', err);
      if (!retriedRef.current) {
        retriedRef.current = true;
        setTimeout(() => { void fetchSummary(); }, 2500);
        return; // isLoading 유지(스켈레톤)
      }
      setIsEmpty(true);
      setSummary(null);
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSummary();
  }, [fetchSummary]);


  // 공유 — Web Share API 우선, 미지원/실패 시 클립보드 복사 + 토스트로 폴백.
  const handleShare = useCallback(async () => {
    if (!summary || !canShare) return;
    // 공유 문구도 센 숫자만 — 도착 확인을 모르면(null) 그 조각 없이.
    const shareText = summary.arrivalsConfirmed !== null
      ? t('impact.shareText', { departures: fmt(summary.accepted), arrivals: fmt(summary.arrivalsConfirmed) })
      : t('impact.shareTextDepartures', { departures: fmt(summary.accepted) });
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
  }, [summary, t, canShare]);

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
        ) : isEmpty ? (
          // 시작 상태 — 숫자·공유 없이, 추천을 고를 곳(지도)으로 바로 보낸다.
          <div className="flex flex-col items-center mt-2 md:max-w-md md:mx-auto md:w-full animate-fade-in">
            <div className="w-full bg-white border border-gold/30 rounded-3xl p-8 flex flex-col items-center text-center shadow-[0_8px_32px_rgba(43,35,32,0.10)]">
              <div className="w-14 h-14 rounded-2xl bg-gold/15 flex items-center justify-center mb-5">
                <Sparkles size={26} className="text-gold-deep" aria-hidden="true" />
              </div>
              <h2 className="text-xl font-bold font-serif text-muk leading-snug">{t('impact.emptyTitle')}</h2>
              <p className="mt-2 text-sm text-muk-soft leading-relaxed">{t('impact.emptyBody')}</p>
              <button
                type="button"
                onClick={() => router.push('/main')}
                className="mt-6 w-full flex items-center justify-center gap-2 py-4 rounded-2xl bg-gold hover:bg-gold-deep text-white font-semibold transition-colors"
              >
                <Compass size={18} aria-hidden="true" />
                <span>{t('impact.emptyCta')}</span>
              </button>
            </div>
          </div>
        ) : summary ? (
          // 공유 카드 — 지표 타일은 백엔드가 실제로 준 것만(방문 타일 없음 — 위 인터페이스 주석 참고).
          <div className="flex flex-col items-center mt-2 md:max-w-md md:mx-auto md:w-full animate-fade-in">
            {/* 헤드라인 — /mypage 최상단 카드가 보여준 바로 그 숫자들(같은 규칙: lib/impactSummary)의 상세다.
                (요약 카드를 탭해서 온 사람이 같은 숫자를 다시 만나야 '상세로 들어왔다'가 성립한다.) */}
            <div className="mb-4 w-full rounded-3xl border border-gold/35 bg-gradient-to-r from-gold/15 via-hanji to-jade/10 p-5 shadow-[0_2px_14px_rgba(43,35,32,0.06)]">
              <span className="inline-flex items-center gap-1.5 text-[13px] font-bold text-muk">
                <Sparkles size={16} className="text-gold-deep" aria-hidden="true" />
                {t('impact.summaryTitle')}
              </span>
              <div className="mt-3 grid grid-cols-2 gap-2">
                {[
                  t('impact.summaryDepartures', { n: fmt(summary.accepted) }),
                  ...(summary.arrivalsConfirmed !== null ? [t('impact.summaryArrivals', { n: fmt(summary.arrivalsConfirmed) })] : []),
                  ...(summary.waitSavedMinutes > 0 ? [t('impact.summarySavedWait', { n: fmt(summary.waitSavedMinutes) })] : []),
                ].map((text) => (
                  <span
                    key={text}
                    className="min-w-0 break-keep rounded-2xl border border-line bg-white/70 px-2 py-2.5 text-center text-[13px] font-black text-muk tabular-nums"
                  >
                    {text}
                  </span>
                ))}
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-muk-soft">{t('impact.summaryRealNote')}</p>
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
                <h2 className="text-2xl font-bold font-serif text-muk mb-1">{isPublic ? t('impact.cardTitle') : t('region.impactCardTitle', { region: regionName })}</h2>
                <p className="text-xs text-muk-soft mb-6">{t('impact.cardSubtitle')}</p>

                {/* 지표 타일 — 근거가 있는 값만(위 머리말). 출발은 언제나, 도착 확인은 서버가 셌을 때, 나머지는 0 보다 클 때. */}
                <div className="grid grid-cols-2 gap-3 w-full mb-6">
                  <Tile
                    icon={<Compass size={20} className="text-terracotta" aria-hidden="true" />}
                    value={t('impact.tileTimesValue', { n: fmt(summary.accepted) })}
                    label={t('impact.metricDepartures')}
                  />
                  {summary.arrivalsConfirmed !== null && (
                    <Tile
                      icon={<MapPin size={20} className="text-jade" aria-hidden="true" />}
                      value={t('impact.tileTimesValue', { n: fmt(summary.arrivalsConfirmed) })}
                      label={t('impact.metricArrivals')}
                    />
                  )}
                  {summary.congestionAvoided > 0 && (
                    <Tile
                      icon={<Wind size={20} className="text-jade" aria-hidden="true" />}
                      value={t('impact.tileTimesValue', { n: fmt(summary.congestionAvoided) })}
                      label={t('impact.metricCongestionAvoided')}
                    />
                  )}
                  {summary.couponsIssued > 0 && (
                    <Tile
                      icon={<Ticket size={20} className="text-gold-deep" aria-hidden="true" />}
                      value={t('impact.tileCouponsIssuedValue', { n: fmt(summary.couponsIssued) })}
                      label={<>
                        {t('impact.metricCouponsIssued')}
                        {summary.couponsUsed > 0 && (
                          <> · {t('impact.metricCouponsUsedInline', { n: fmt(summary.couponsUsed) })}</>
                        )}
                      </>}
                    />
                  )}
                  {summary.waitSavedMinutes > 0 && (
                    <Tile
                      icon={<Clock size={20} className="text-muk-soft" aria-hidden="true" />}
                      value={t('impact.tileWaitSavedValue', { n: fmt(summary.waitSavedMinutes) })}
                      label={t('impact.metricWaitSaved')}
                    />
                  )}
                </div>

                {/* 세는 규칙 한 줄 — 한 번의 결정을 여러 번으로 세지 않는다(서버 impact.py). */}
                <p className="text-[11px] text-muk-soft leading-relaxed">{t('impact.countNote')}</p>
              </div>
            </div>

            {/* 공유 버튼 — 공유가 꺼진 지역에서는 그리지 않는다. */}
            {canShare && (
              <button
                type="button"
                onClick={() => void handleShare()}
                className="mt-6 w-full flex items-center justify-center gap-2 py-4 rounded-2xl bg-gold hover:bg-gold-deep text-white font-semibold transition-colors"
              >
                <Share2 size={18} />
                <span>{t('impact.shareButton')}</span>
              </button>
            )}
          </div>
        ) : null}
      </main>
    </div>
  );
}

// 지표 타일 하나 — 아이콘 · 값(크게) · 이름. 값과 이름은 로케일 문장을 통째로 받는다.
function Tile({ icon, value, label }: { icon: ReactNode; value: string; label: ReactNode }) {
  return (
    <div className="min-w-0 w-full flex flex-col items-center gap-1.5 bg-hanji rounded-2xl border border-line p-4">
      {icon}
      <span className="w-full min-w-0 text-xl font-bold text-muk break-words text-center">{value}</span>
      <span className="w-full min-w-0 text-[11px] text-muk-soft font-medium text-center break-words">{label}</span>
    </div>
  );
}
