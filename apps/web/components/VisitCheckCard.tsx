'use client';

// 방문 확인 루프 배너 — 수락(길안내 시작) 후 30분이 지나면 '○○ 다녀오셨나요?' 를 하단 배너로 띄운다.
//
// 트리거: main 마운트 + 문서 visibilitychange(visible) 시 lib/visits.getDueVisit() 을 재확인한다
//   (앱을 잠시 떠났다 돌아오면 방문 완료 시점과 맞물려 자연스럽게 노출된다).
// 처리: [예 — 원탭 혼잡 제보(CongestionReportButton 재사용) + 👍 좋았어요/👎 별로] → visit_history 적립 + pending 클리어.
//   [아직이요/닫기] → pending 클리어(재노출 안 함, 다시 수락하면 새 루프).
// 팔레트·포털 관례는 FestivalBanner/CongestionReportButton 을 따른다(한지 웜톤 + body 포털 + framer-motion).

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X, ThumbsUp, ThumbsDown, MapPin } from 'lucide-react';
import { CongestionReportButton } from '@/components/CongestionReportButton';
import { getDueVisit, completeVisit, markTripNavigating, type PendingVisit } from '@/lib/visits';
import { useT } from '@/lib/i18n/I18nProvider';

export function VisitCheckCard({ showToast }: { showToast?: (msg: string) => void }) {
  const t = useT();
  const [due, setDue] = useState<PendingVisit | null>(null);
  const [stage, setStage] = useState<'ask' | 'feedback'>('ask');
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

  // [아직이요/닫기] — pending 을 지워 재노출하지 않는다(다시 수락하면 새 루프 시작).
  const dismiss = () => {
    markTripNavigating();
    window.dispatchEvent(new Event('nextspot:trip-navigating'));
    setDue(null);
    setStage('ask');
  };

  // 👍/👎 로 방문 확정 — visit_history 적립 + pending 클리어.
  const finish = (rating: 'up' | 'down') => {
    completeVisit({ facilityId: due.facilityId, name: due.name, type: due.type, rating });
    import('@/lib/analytics').then(({ track }) => track('visit_confirmed', { facility_type: due.type, rating }));
    showToast?.(t('visit.thanks'));
    setDue(null);
    setStage('ask');
  };

  return createPortal(
    <AnimatePresence>
      <motion.div
        key="visit-check"
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 24 }}
        transition={{ type: 'spring', bounce: 0.25, duration: 0.5 }}
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
            className="absolute top-3 right-3 p-1 rounded-full text-muk-soft hover:text-muk hover:bg-hanji-deep transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/50"
          >
            <X size={16} />
          </button>

          {stage === 'ask' ? (
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
                  className="flex-1 bg-hanji-deep hover:bg-terracotta/10 hover:text-terracotta hover:border-terracotta/30 text-muk-soft font-bold py-2.5 rounded-2xl border border-line transition-all active:scale-95 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
                >
                  {t('visit.notYet')}
                </button>
                <button
                  type="button"
                  onClick={() => setStage('feedback')}
                  className="flex-1 bg-gradient-to-r from-gold to-terracotta hover:from-gold-deep hover:to-terracotta text-white font-bold py-2.5 rounded-2xl transition-all active:scale-95 text-xs shadow-[0_4px_14px_rgba(193,85,59,0.25)] focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
                >
                  {t('visit.yes')}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3 pr-6">
              <div className="min-w-0">
                <p className="text-sm font-bold text-muk leading-snug break-keep truncate">{due.name}</p>
                <p className="text-[11px] text-muk-soft mt-0.5 leading-snug">{t('visit.feedbackTitle')}</p>
              </div>

              {/* 원탭 혼잡 제보(선택) — 기존 컴포넌트 재사용(자기완결형 모달). */}
              <div className="flex justify-center">
                <CongestionReportButton facility={{ id: due.facilityId, name: due.name }} />
              </div>

              {/* 👍/👎 — 어느 쪽이든 방문 확정(이력 적립 + pending 클리어). */}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => finish('down')}
                  className="flex-1 flex items-center justify-center gap-1.5 bg-hanji-deep hover:bg-terracotta/10 hover:text-terracotta hover:border-terracotta/30 text-muk-soft font-bold py-2.5 rounded-2xl border border-line transition-all active:scale-95 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
                >
                  <ThumbsDown size={14} />
                  {t('visit.disliked')}
                </button>
                <button
                  type="button"
                  onClick={() => finish('up')}
                  className="flex-1 flex items-center justify-center gap-1.5 bg-jade/15 hover:bg-jade/25 text-jade font-bold py-2.5 rounded-2xl border border-jade/40 transition-all active:scale-95 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-jade/50"
                >
                  <ThumbsUp size={14} />
                  {t('visit.liked')}
                </button>
              </div>
            </div>
          )}
        </div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}

export default VisitCheckCard;
