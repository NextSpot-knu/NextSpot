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
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Users, X } from 'lucide-react';
import { apiClient, httpStatus, isAuthError } from '@/lib/api-client';
import { useT } from '@/lib/i18n/I18nProvider';
import { haptic, sheetSpring } from '@/lib/motion';

// 최소 시설 형태만 요구(id/name). 추천 응답 facility·지도 마커 등 id/name 을 가진 어떤 객체와도 호환.
interface ReportableFacility {
  id: string;
  name: string;
}

interface CongestionReportButtonProps {
  facility: ReportableFacility;
  // 선택: 부모의 토스트 시스템으로 위임하고 싶으면 주입(없으면 컴포넌트 내장 토스트 사용).
  onReported?: (level: '한산' | '보통' | '혼잡') => void;
  // 아직 현장 정보가 없는 장소에서는 콜드스타트 해결 행동을 직접 안내한다.
  isFirst?: boolean;
  className?: string;
}

type Level = '한산' | '보통' | '혼잡';

interface CongestionReportResponse {
  reward?: {
    reportCount: number;
    couponIssued: boolean;
    nextRewardIn: number;
  };
}

// 3지선다 옵션 — value(백엔드 전송·로직용, 한국어 고정)/i18n 키/한지 웜톤 색 토큰.
const LEVEL_OPTIONS: {
  value: Level;
  emoji: string;
  labelKey: string; // congestion 네임스페이스
  descKey: string;  // report 네임스페이스
  // 선택 강조용 Tailwind 클래스(정적 문자열 — JIT purge 안전).
  ring: string;
  activeBg: string;
}[] = [
  { value: '한산', emoji: '🍃', labelKey: 'congestion.quiet', descKey: 'report.quietDesc', ring: 'hover:border-jade/50', activeBg: 'border-jade bg-jade/10 text-jade' },
  { value: '보통', emoji: '🙂', labelKey: 'congestion.moderate', descKey: 'report.moderateDesc', ring: 'hover:border-gold/50', activeBg: 'border-gold bg-gold/10 text-gold-deep' },
  { value: '혼잡', emoji: '🔥', labelKey: 'congestion.busy', descKey: 'report.busyDesc', ring: 'hover:border-terracotta/50', activeBg: 'border-terracotta bg-terracotta/10 text-terracotta' },
];

export function CongestionReportButton({ facility, onReported, isFirst = false, className = '' }: CongestionReportButtonProps) {
  const t = useT();
  const [isOpen, setIsOpen] = useState(false);
  const [selected, setSelected] = useState<Level | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<{ msg: string; kind: 'success' | 'error' } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // position:fixed 오버레이(모달·토스트)는 이 컴포넌트가 transform+overflow-hidden 인
  // RecommendationCard(motion.div) 안에 마운트되면 카드 크기로 클리핑된다. document.body 로
  // 포털해 변형된 조상에서 탈출시킨다. SSR/정적 export 안전을 위해 마운트 후에만 포털한다.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

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

  const submit = async (level: Level) => {
    if (submitting) return;
    setSelected(level);
    haptic('confirm');
    setSubmitting(true);
    try {
      // 백엔드가 라벨(한산/보통/혼잡)을 0~1 로 매핑한다. facilityId → snake_case 변환은 api-client 담당.
      const response: CongestionReportResponse = await apiClient.post('/api/v1/reports/congestion', {
        facilityId: facility.id,
        level,
      });
      onReported?.(level);
      haptic('success');
      // 언어에 상관없이 즉시 읽히는 짧은 진행 배지. 3회째에는 쿠폰 +1을 명확히 보여준다.
      const rewardMessage = response.reward?.couponIssued
        ? '🎟️ +1'
        : response.reward?.nextRewardIn
          ? `🎯 ${3 - response.reward.nextRewardIn}/3`
          : null;
      const successMessage = t('report.success', { name: facility.name });
      showToast(rewardMessage ? `${successMessage} · ${rewardMessage}` : successMessage, 'success');
      setIsOpen(false);
    } catch (err) {
      // 백엔드 다운/인증 만료/쿨다운 — graceful degradation(앱은 계속 동작).
      //
      // 예전에는 err.message 에 '401' 이나 'auth' 가 들어 있는지로 갈랐다. api-client 는
      // 서버가 준 한국어 detail 을 그대로 message 에 싣기 때문에, 토큰이 만료돼도 문구에
      // 그 글자가 없으면 인증 안내 대신 "잠시 후 다시" 가 떴다. 타입 가드로 가른다.
      //
      // 서버 detail 은 토스트에 그대로 쓰지 않는다 — 전부 한국어인데 이 화면은 4개 국어다.
      const friendly = isAuthError(err)
        ? t('report.authError')
        : httpStatus(err) === 429
          ? t('report.cooldownError')
          : t('report.failError');
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
        onClick={() => {
          haptic('selection');
          setIsOpen(true);
        }}
        aria-haspopup="dialog"
        aria-label={t('report.triggerAria', { name: facility.name })}
        className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-full border text-xs font-bold transition-all active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/50 ${
          isFirst
            ? 'bg-jade/10 border-jade/35 text-jade hover:bg-jade/20 hover:border-jade/55'
            : 'bg-hanji-deep border-line text-muk-soft hover:bg-gold/10 hover:border-gold/40 hover:text-gold-deep'
        } ${className}`}
      >
        <Users size={14} />
        {isFirst ? `${t('card.noData')} · ${t('report.trigger')}` : t('report.trigger')}
      </button>

      {/* 토스트 — 성공(청록)/에러(주칠). 부모 토스트를 안 쓸 때의 내장 폴백. body 로 포털. */}
      {mounted && createPortal(
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
        </AnimatePresence>,
        document.body,
      )}

      {/* 모달 — body 로 포털(변형된 조상 클리핑 회피). */}
      {mounted && createPortal(
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
              aria-label={t('common.close')}
              tabIndex={-1}
              onClick={() => !submitting && setIsOpen(false)}
              className="absolute inset-0 bg-muk/40 backdrop-blur-sm"
            />

            <motion.div
              initial={{ y: 40, opacity: 0, scale: 0.98 }}
              animate={{ y: 0, opacity: 1, scale: 1 }}
              exit={{ y: 40, opacity: 0, scale: 0.98 }}
              transition={sheetSpring}
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
                    {t('report.title')}
                  </h2>
                  <p className="text-xs text-muk-soft mt-1 font-medium truncate max-w-[220px]">{facility.name}</p>
                </div>
                <button
                  type="button"
                  onClick={() => !submitting && setIsOpen(false)}
                  aria-label={t('common.close')}
                  className="p-1.5 rounded-full text-muk-soft hover:text-muk hover:bg-hanji-deep transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/50"
                >
                  <X size={18} />
                </button>
              </div>

              {/* 3지선다 */}
              <div className="grid grid-cols-3 gap-2.5" role="radiogroup" aria-label={t('report.selectAria')}>
                {LEVEL_OPTIONS.map((opt) => {
                  const active = selected === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      disabled={submitting}
                      onClick={() => void submit(opt.value)}
                      className={`flex flex-col items-center gap-1.5 py-4 rounded-2xl border-2 bg-white/60 transition-all active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/50 disabled:opacity-60 ${
                        active ? opt.activeBg : `border-line text-muk-soft ${opt.ring}`
                      }`}
                    >
                      <span className="text-2xl leading-none" aria-hidden>{opt.emoji}</span>
                      <span className="text-sm font-bold">{t(opt.labelKey)}</span>
                      <span className="text-[10px] text-muk-soft font-medium">{t(opt.descKey)}</span>
                    </button>
                  );
                })}
              </div>

              {/* 옵션을 누르는 순간 제출된다. 두 번째 확인 버튼 없이 한 번의 탭으로 끝낸다. */}
              <div className="h-5 flex items-center justify-center" role="status" aria-live="polite">
                {submitting && (
                  <span className="inline-flex items-center gap-2 text-xs font-bold text-gold-deep">
                    <span className="w-3.5 h-3.5 border-2 border-gold/30 border-t-gold-deep rounded-full animate-spin" aria-hidden />
                    {t('report.submitting')}
                  </span>
                )}
              </div>

              <p className="text-[10px] text-muk-soft/80 text-center leading-relaxed">
                {t('report.footer')}
              </p>
            </motion.div>
          </motion.div>
        )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}

export default CongestionReportButton;
