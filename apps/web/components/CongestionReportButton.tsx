'use client';

// 혼잡 제보(크라우드소싱) 버튼 + 모달.
// "지금 이곳 얼마나 붐비나요?" → 한산/보통/혼잡 3지선다 → 백엔드로 제보.
//
// 보안: congestion_logs 는 service_role 만 INSERT 가능(RLS). 그래서 Supabase 직접 insert 가
//   아니라 FastAPI POST /api/v1/reports/congestion (get_current_user 인증)을 거친다.
//   백엔드가 supabase_admin(service_role) 으로 기록한다.
//
// 팔레트: 한지 웜톤 토큰(gold/jade/terracotta/muk/hanji) 사용. 백엔드 다운 시 graceful(에러 토스트).
// 통합: 이 컴포넌트는 자기완결형이다. 통합 담당자가 facility prop 을 넘겨 원하는 곳에 마운트한다.

import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Users, X, Check } from 'lucide-react';
import { apiClient } from '@/lib/api-client';

// 최소 시설 형태만 요구(id/name). lib/types.ts 의 Facility 나 추천 응답 facility 모두 호환.
interface ReportableFacility {
  id: string;
  name: string;
}

interface CongestionReportButtonProps {
  facility: ReportableFacility;
  // 선택: 부모의 토스트 시스템으로 위임하고 싶으면 주입(없으면 컴포넌트 내장 토스트 사용).
  onReported?: (level: '한산' | '보통' | '혼잡') => void;
  className?: string;
}

type Level = '한산' | '보통' | '혼잡';

// 3지선다 옵션 — 라벨/설명/한지 웜톤 색 토큰.
const LEVEL_OPTIONS: {
  value: Level;
  emoji: string;
  desc: string;
  // 선택 강조용 Tailwind 클래스(정적 문자열 — JIT purge 안전).
  ring: string;
  activeBg: string;
}[] = [
  { value: '한산', emoji: '🍃', desc: '여유로워요', ring: 'hover:border-jade/50', activeBg: 'border-jade bg-jade/10 text-jade' },
  { value: '보통', emoji: '🙂', desc: '적당해요', ring: 'hover:border-gold/50', activeBg: 'border-gold bg-gold/10 text-gold-deep' },
  { value: '혼잡', emoji: '🔥', desc: '붐벼요', ring: 'hover:border-terracotta/50', activeBg: 'border-terracotta bg-terracotta/10 text-terracotta' },
];

export function CongestionReportButton({ facility, onReported, className = '' }: CongestionReportButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [selected, setSelected] = useState<Level | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<{ msg: string; kind: 'success' | 'error' } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (msg: string, kind: 'success' | 'error') => {
    setToast({ msg, kind });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  };

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  // 모달 열릴 때 ESC 로 닫기 + 선택 초기화.
  useEffect(() => {
    if (!isOpen) return;
    setSelected(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) setIsOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, submitting]);

  const submit = async () => {
    if (!selected || submitting) return;
    setSubmitting(true);
    try {
      // 백엔드가 라벨(한산/보통/혼잡)을 0~1 로 매핑한다. facilityId → snake_case 변환은 api-client 담당.
      await apiClient.post('/api/v1/reports/congestion', {
        facilityId: facility.id,
        level: selected,
      });
      onReported?.(selected);
      showToast(`'${facility.name}' 혼잡 제보 완료! 다른 여행자에게 도움이 돼요 🙏`, 'success');
      setIsOpen(false);
    } catch (err) {
      // 백엔드 다운/인증 만료 등 — graceful degradation(앱은 계속 동작).
      const message = err instanceof Error ? err.message : '';
      const friendly = message.includes('401') || message.toLowerCase().includes('auth')
        ? '로그인 후 제보할 수 있어요.'
        : '지금은 제보를 보낼 수 없어요. 잠시 후 다시 시도해 주세요.';
      showToast(friendly, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      {/* 트리거 버튼 — 한지 웜톤, 작은 pill */}
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        aria-haspopup="dialog"
        aria-label={`${facility.name} 혼잡도 제보하기`}
        className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-full bg-hanji-deep hover:bg-gold/10 border border-line hover:border-gold/40 text-muk-soft hover:text-gold-deep text-xs font-bold transition-all active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/50 ${className}`}
      >
        <Users size={14} />
        혼잡 제보
      </button>

      {/* 토스트 — 성공(청록)/에러(주칠). 부모 토스트를 안 쓸 때의 내장 폴백. */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            role="status"
            aria-live="polite"
            className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[70] pointer-events-none w-full max-w-sm px-4 flex justify-center"
          >
            <div
              className={`px-4 py-3 rounded-2xl shadow-[0_8px_30px_rgba(43,35,32,0.18)] text-sm font-bold text-white text-center ${
                toast.kind === 'success' ? 'bg-jade' : 'bg-terracotta'
              }`}
            >
              {toast.msg}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 모달 */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center"
          >
            {/* Backdrop */}
            <button
              type="button"
              aria-label="닫기"
              tabIndex={-1}
              onClick={() => !submitting && setIsOpen(false)}
              className="absolute inset-0 bg-muk/40 backdrop-blur-sm"
            />

            <motion.div
              initial={{ y: 40, opacity: 0, scale: 0.98 }}
              animate={{ y: 0, opacity: 1, scale: 1 }}
              exit={{ y: 40, opacity: 0, scale: 0.98 }}
              transition={{ type: 'spring', bounce: 0.25, duration: 0.5 }}
              role="dialog"
              aria-modal="true"
              aria-labelledby="congestion-report-title"
              className="relative w-full max-w-sm bg-hanji border border-line rounded-t-3xl sm:rounded-3xl p-6 shadow-[0_-8px_40px_rgba(43,35,32,0.2)] sm:shadow-[0_20px_60px_rgba(43,35,32,0.25)] flex flex-col gap-5"
            >
              {/* 상단 장식 라인 */}
              <div className="absolute top-0 left-0 right-0 h-[3px] rounded-t-3xl bg-gradient-to-r from-transparent via-gold/60 to-transparent" />

              {/* 헤더 */}
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 id="congestion-report-title" className="text-lg font-serif font-bold text-muk leading-tight">
                    지금 이곳 얼마나 붐비나요?
                  </h2>
                  <p className="text-xs text-muk-soft mt-1 font-medium truncate max-w-[220px]">{facility.name}</p>
                </div>
                <button
                  type="button"
                  onClick={() => !submitting && setIsOpen(false)}
                  aria-label="닫기"
                  className="p-1.5 rounded-full text-muk-soft hover:text-muk hover:bg-hanji-deep transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/50"
                >
                  <X size={18} />
                </button>
              </div>

              {/* 3지선다 */}
              <div className="grid grid-cols-3 gap-2.5" role="radiogroup" aria-label="혼잡도 선택">
                {LEVEL_OPTIONS.map((opt) => {
                  const active = selected === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      disabled={submitting}
                      onClick={() => setSelected(opt.value)}
                      className={`flex flex-col items-center gap-1.5 py-4 rounded-2xl border-2 bg-white/60 transition-all active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/50 disabled:opacity-60 ${
                        active ? opt.activeBg : `border-line text-muk-soft ${opt.ring}`
                      }`}
                    >
                      <span className="text-2xl leading-none" aria-hidden>{opt.emoji}</span>
                      <span className="text-sm font-bold">{opt.value}</span>
                      <span className="text-[10px] text-muk-soft font-medium">{opt.desc}</span>
                    </button>
                  );
                })}
              </div>

              {/* 제출 */}
              <button
                type="button"
                onClick={submit}
                disabled={!selected || submitting}
                className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-gold to-terracotta hover:from-gold-deep hover:to-terracotta text-white font-bold py-3.5 rounded-2xl transition-all active:scale-95 shadow-[0_4px_14px_rgba(193,85,59,0.25)] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/50"
              >
                {submitting ? (
                  <>
                    <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" aria-hidden />
                    제보 중…
                  </>
                ) : (
                  <>
                    <Check size={16} />
                    제보하기
                  </>
                )}
              </button>

              <p className="text-[10px] text-muk-soft/80 text-center leading-relaxed">
                여러분의 제보가 다른 여행자의 발걸음을 분산시켜요.
              </p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

export default CongestionReportButton;
