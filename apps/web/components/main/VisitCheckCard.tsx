'use client';

// 방문 확인 루프 배너 — 수락(길안내 시작) 후 30분이 지나면 '○○ 다녀오셨나요?' 를 하단 배너로 띄운다.
//
// 트리거: main 마운트 + 문서 visibilitychange(visible) 시 lib/visits.getDueVisit() 을 재확인한다
//   (앱을 잠시 떠났다 돌아오면 방문 완료 시점과 맞물려 자연스럽게 노출된다).
// 처리: [예 → 원탭 혼잡 → 👍/👎] 순서로 가장 중요한 현장 신호를 먼저 받고 방문 이력을 확정한다.
//   [아직이요/닫기] → lib/visits.dismissVisitCheck() 로 pending + active trip 을 함께 지운다
//   (저장까지 끝나므로 탭을 다시 열어도 재노출 안 함, 다시 수락하면 새 루프).
// 팔레트·포털 관례는 FestivalBanner/CongestionReportButton 을 따른다(한지 웜톤 + body 포털 + framer-motion).

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, X, ThumbsUp, ThumbsDown, MapPin } from 'lucide-react';
import { getDueVisit, completeVisit, dismissVisitCheck, type PendingVisit } from '@/lib/visits';
import { useT } from '@/lib/i18n/I18nProvider';
import { queueRecommendationOutcome, type ObservedCongestion, type OutcomeRating } from '@/lib/recommendationOutcomes';
import { haptic, interactionSpring, sheetSpring } from '@/lib/motion';

export function VisitCheckCard({ showToast }: { showToast?: (msg: string) => void }) {
  const t = useT();
  const [due, setDue] = useState<PendingVisit | null>(null);
  const [stage, setStage] = useState<'ask' | 'congestion' | 'feedback' | 'completed'>('ask');
  const [observedCongestion, setObservedCongestion] = useState<ObservedCongestion | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // 마운트 + 탭 복귀(visibilitychange) 때 방문 확인 대상 재확인.
  useEffect(() => {
    const check = () => {
      const d = getDueVisit();
      setDue(d);
      if (!d) setStage('ask');
    };
    check();
    const onVis = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('nextspot:trip-arrived', check);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('nextspot:trip-arrived', check);
    };
  }, []);

  if (!mounted || !due) return null;

  // [아직이요/닫기] — 로컬 state 만 끄면 탭을 다시 열 때마다 되살아난다(getDueVisit 이 pending 을
  // 그대로 다시 읽는다). 저장소의 pending + active trip 을 함께 지워 루프를 완전히 종료한다.
  // 이때 ActiveJourneyCard 도 같이 사라져야 상태가 어긋나지 않는데, 그 카드가 듣는 재동기화
  // 신호는 'nextspot:trip-navigating' 하나뿐이다 — 이름과 달리 핸들러는 그냥 getActiveTrip() 을
  // 다시 읽으므로, 여정이 지워진 지금 dispatch 하면 카드가 스스로 숨는다.
  const dismiss = () => {
    haptic('selection');
    dismissVisitCheck();
    window.dispatchEvent(new Event('nextspot:trip-navigating'));
    setDue(null);
    setStage('ask');
  };

  // [예] — 여기서 확정하지 않는다. 혼잡 → 👍/👎 단계로 넘기고, 이력 적립과 클리어는
  // 마지막 finishRating 의 completeVisit 이 한다.
  const confirmArrival = () => {
    haptic('confirm');
    queueRecommendationOutcome(due.recommendationId, 'arrival_confirmed');
    setObservedCongestion(null);
    setStage('congestion');
  };

  const selectCongestion = (value?: ObservedCongestion) => {
    haptic(value ? 'confirm' : 'selection');
    setObservedCongestion(value ?? null);
    setStage('feedback');
  };

  const finishRating = (nextRating: OutcomeRating) => {
    haptic('confirm');
    completeVisit({ facilityId: due.facilityId, name: due.name, type: due.type, rating: nextRating });
    queueRecommendationOutcome(due.recommendationId, 'rated', {
      rating: nextRating,
      observedCongestion: observedCongestion ?? undefined,
    });
    import('@/lib/analytics').then(({ track }) => track('visit_confirmed', { facility_type: due.type, rating: nextRating }));
    haptic('success');
    showToast?.(t('visit.thanks'));
    setStage('completed');
  };

  return createPortal(
    <AnimatePresence>
      <motion.div
        key="visit-check"
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 24 }}
        transition={sheetSpring}
        className="fixed z-[55] left-1/2 -translate-x-1/2 bottom-[calc(88px+env(safe-area-inset-bottom))] w-full max-w-sm px-4"
      >
        <div className="relative bg-white/95 backdrop-blur-2xl border border-line rounded-3xl p-4 shadow-[0_8px_30px_rgba(43,35,32,0.16)]">
          {/* 상단 장식 라인 */}
          <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-jade/50 to-transparent" />

          {/* 닫기 */}
          <button
            type="button"
            onClick={dismiss}
            aria-label={t('common.close')}
            className="toss-pressable absolute top-3 right-3 p-1 rounded-full text-muk-soft hover:text-muk hover:bg-hanji-deep transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/50"
          >
            <X size={16} />
          </button>

          {stage !== 'completed' && (
            <div className="mb-3 flex gap-1.5 pr-8" aria-hidden>
              {(['ask', 'congestion', 'feedback'] as const).map((item, index) => {
                const activeIndex = ['ask', 'congestion', 'feedback'].indexOf(stage);
                return (
                  <motion.span
                    key={item}
                    className={`h-1.5 rounded-full ${index <= activeIndex ? 'bg-jade' : 'bg-line'}`}
                    animate={{ width: index === activeIndex ? 28 : 10 }}
                    transition={interactionSpring}
                  />
                );
              })}
            </div>
          )}

          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={stage}
              initial={{ opacity: 0, x: 18, scale: 0.99 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: -14, scale: 0.99 }}
              transition={interactionSpring}
            >
          {stage === 'completed' ? (
            <div className="flex flex-col gap-3 pr-6" data-testid="visit-completed">
              <div className="flex items-start gap-2.5">
                <motion.span
                  initial={{ scale: 0, rotate: -18 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={sheetSpring}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-jade text-white"
                >
                  <Check size={18} aria-hidden />
                </motion.span>
                <div>
                <p className="text-sm font-bold text-muk">{t('visit.thanks')}</p>
                <p className="mt-1 text-[11px] leading-snug text-muk-soft">{t('visit.askDesc')}</p>
                </div>
              </div>
              <Link href="/mypage/coupons" className="toss-pressable rounded-2xl bg-jade py-2.5 text-center text-xs font-bold text-white">
                {t('mypage.menuCoupons')}
              </Link>
              <button type="button" onClick={() => { haptic('selection'); setDue(null); setStage('ask'); }} className="toss-pressable text-xs font-bold text-muk-soft">
                {t('common.close')}
              </button>
            </div>
          ) : stage === 'ask' ? (
            <div className="flex flex-col gap-3 pr-6">
              <div className="flex items-start gap-2.5">
                <span className="w-9 h-9 shrink-0 rounded-full bg-jade/10 border border-jade/25 flex items-center justify-center text-jade">
                  <MapPin size={18} aria-hidden />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-bold text-muk leading-snug break-keep">
                    {t('visit.askTitle', { name: due.name })}
                  </p>
                  <p className="text-[11px] text-muk-soft mt-0.5 leading-snug">{t('visit.askDesc')}</p>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={dismiss}
                  className="toss-pressable flex-1 bg-hanji-deep hover:bg-terracotta/10 hover:text-terracotta hover:border-terracotta/30 text-muk-soft font-bold py-2.5 rounded-2xl border border-line text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
                >
                  {t('visit.notYet')}
                </button>
                <button
                  type="button"
                  onClick={confirmArrival}
                  className="toss-pressable flex-1 bg-gradient-to-r from-gold to-terracotta hover:from-gold-deep hover:to-terracotta text-white font-bold py-2.5 rounded-2xl text-xs shadow-[0_4px_14px_rgba(193,85,59,0.25)] focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
                >
                  {t('visit.yes')}
                </button>
              </div>
            </div>
          ) : stage === 'feedback' ? (
            <div className="flex flex-col gap-3 pr-6">
              <div className="min-w-0">
                <p className="text-sm font-bold text-muk leading-snug break-keep truncate">{due.name}</p>
                <p className="text-[11px] text-muk-soft mt-0.5 leading-snug">{t('visit.feedbackTitle')}</p>
              </div>

              {/* 👍/👎 — 어느 쪽이든 방문 확정(이력 적립 + pending 클리어). */}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => finishRating('down')}
                  className="toss-pressable flex-1 flex items-center justify-center gap-1.5 bg-hanji-deep hover:bg-terracotta/10 hover:text-terracotta hover:border-terracotta/30 text-muk-soft font-bold py-2.5 rounded-2xl border border-line text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
                >
                  <ThumbsDown size={14} />
                  {t('visit.disliked')}
                </button>
                <button
                  type="button"
                  onClick={() => finishRating('up')}
                  className="toss-pressable flex-1 flex items-center justify-center gap-1.5 bg-jade/15 hover:bg-jade/25 text-jade font-bold py-2.5 rounded-2xl border border-jade/40 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-jade/50"
                >
                  <ThumbsUp size={14} />
                  {t('visit.liked')}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3 pr-6">
              <div>
                <p className="text-sm font-bold text-muk">{t('report.title')}</p>
                <p className="mt-0.5 text-[11px] text-muk-soft">{t('report.footer')}</p>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {([
                  ['quiet', 'congestion.quiet', 'report.quietDesc'],
                  ['normal', 'congestion.moderate', 'report.moderateDesc'],
                  ['busy', 'congestion.busy', 'report.busyDesc'],
                ] as const).map(([value, labelKey, descKey]) => (
                  <button key={value} type="button" onClick={() => selectCongestion(value)} className="toss-pressable rounded-2xl border border-line bg-hanji-deep px-2 py-2 text-xs font-bold text-muk">
                    <span className="block">{t(labelKey)}</span>
                    <span className="mt-0.5 block text-[10px] font-normal text-muk-soft">{t(descKey)}</span>
                  </button>
                ))}
              </div>
              <button type="button" onClick={() => selectCongestion()} className="toss-pressable text-xs font-bold text-muk-soft">{t('common.close')}</button>
            </div>
          )}
            </motion.div>
          </AnimatePresence>
        </div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}

export default VisitCheckCard;
