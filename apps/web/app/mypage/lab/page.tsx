'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronLeft, FlaskConical, AlertCircle, Compass, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  isAuthError,
  fetchLabPending,
  answerLabReason,
  skipLabItem,
  hideLabItem,
  type LabPendingItem,
  type LabReasonCode,
} from '@/lib/api-client';
import { useI18n } from '@/lib/i18n/I18nProvider';

// 이유 칩 9종 — docs/REJECTION_LAB_AUDIT.md 의 reason_code 목록과 1:1 (백엔드 CHECK 제약과 동일 순서).
// 'other' 만 메모 입력을 연다(learning_scope=none — 취향 학습 없이 자유 서술만 수집).
const REASON_CODES: readonly LabReasonCode[] = [
  'too_far',
  'too_crowded',
  'not_my_taste',
  'too_expensive',
  'closed',
  'already_visited',
  'bad_timing',
  'inaccurate',
  'other',
] as const;

// 시설 유형(캐노니컬 키) — i18n category 네임스페이스로 표시명을 번역한다(coupons 페이지와 동일 규약).
const TYPE_IDS = ['restaurant', 'cafe', 'attraction', 'culture'];

// reason_note DB CHECK 는 200자 이하 — 입력 단계에서 동일 상한을 강제해 400 왕복을 막는다.
const NOTE_MAX = 200;

// 4개 로케일 → Intl BCP47 태그. 추천 시각은 사용자가 고른 언어로 읽혀야 한다.
const INTL_LOCALE: Record<string, string> = {
  ko: 'ko-KR',
  en: 'en-US',
  ja: 'ja-JP',
  zh: 'zh-CN',
};

function formatRecommendedAt(iso: string, locale: string): string {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  try {
    return new Date(ms).toLocaleString(INTL_LOCALE[locale] ?? 'ko-KR', {
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

export default function LabPage() {
  const router = useRouter();
  const { locale, t } = useI18n();
  const [items, setItems] = useState<LabPendingItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  // 401 은 서버 장애가 아니다 — '다시 시도'가 성공할 수 없으므로 재시도 버튼을 숨긴다(무한 재시도 금지).
  const [needsAuth, setNeedsAuth] = useState(false);
  // '기타'를 고른 카드만 메모 입력을 연다(feedbackId).
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [noteText, setNoteText] = useState('');
  // 처리 중인 카드 — 중복 제출(멱등 upsert 는 백엔드가 보장하지만 UI 이중 클릭)을 막는다.
  const [busyId, setBusyId] = useState<string | null>(null);

  // 첫 실패는 익명 세션 부트스트랩(SessionBootstrap) 완료 전 레이스일 수 있어 2.5초 유예 후 1회만
  // 자동 재시도한다(impact 페이지와 동일 패턴 — 유한 재시도라 무한 스켈레톤이 아니다).
  const retriedRef = useRef(false);
  const aliveRef = useRef(true);

  const loadPending = useCallback(async () => {
    setIsLoading(true);
    setHasError(false);
    setNeedsAuth(false);
    try {
      const data = await fetchLabPending();
      if (!aliveRef.current) return;
      setItems(Array.isArray(data) ? data : []);
      setIsLoading(false);
    } catch (err) {
      console.warn('Failed to fetch lab pending', err);
      if (!aliveRef.current) return;
      if (!retriedRef.current && !isAuthError(err)) {
        retriedRef.current = true;
        setTimeout(() => { void loadPending(); }, 2500);
        return; // isLoading 유지(스켈레톤)
      }
      if (isAuthError(err)) setNeedsAuth(true);
      setHasError(true);
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void loadPending();
    return () => { aliveRef.current = false; };
  }, [loadPending]);

  // 답변/건너뛰기/제거 공통 — 낙관적으로 목록에서 즉시 제거하고, 실패하면 이전 목록으로 롤백한다.
  const mutate = useCallback(
    async (feedbackId: string, run: () => Promise<void>, successKey: string) => {
      if (busyId) return;
      setBusyId(feedbackId);
      const snapshot = items;
      setItems((prev) => prev.filter((it) => it.feedbackId !== feedbackId));
      setNoteFor((prev) => (prev === feedbackId ? null : prev));
      try {
        await run();
        toast.success(t(successKey));
      } catch (err) {
        console.warn('lab mutation failed', err);
        setItems(snapshot); // 롤백 — 서버에 반영되지 않은 것을 사라진 것처럼 보이게 두지 않는다.
        toast.error(t('common.error'));
      } finally {
        setBusyId(null);
      }
    },
    [busyId, items, t],
  );

  const handleReason = useCallback(
    (item: LabPendingItem, code: LabReasonCode) => {
      // '기타'는 메모를 받아야 하므로 바로 제출하지 않고 입력창만 연다(메모는 선택 — 빈 채로도 보낼 수 있다).
      if (code === 'other') {
        setNoteFor(item.feedbackId);
        setNoteText('');
        return;
      }
      void mutate(item.feedbackId, () => answerLabReason(item.feedbackId, code), 'lab.answered');
    },
    [mutate],
  );

  const handleNoteSubmit = useCallback(
    (item: LabPendingItem) => {
      const note = noteText.trim();
      void mutate(
        item.feedbackId,
        () => answerLabReason(item.feedbackId, 'other', note || undefined),
        'lab.answered',
      );
    },
    [mutate, noteText],
  );

  return (
    <div className="relative w-full h-[100dvh] bg-hanji flex flex-col overflow-hidden">

      {/* 헤더 */}
      <header className="flex items-center gap-3 p-5 z-10 relative">
        <button
          type="button"
          // 마이페이지에서만 진입하는 화면이라 settings/privacy 와 동일한 '마이페이지로 돌아가기' 라벨을 쓴다.
          aria-label={t('settings.backAria')}
          onClick={() => router.back()}
          className="text-muk-soft hover:text-muk transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 rounded-lg"
        >
          <ChevronLeft size={24} />
        </button>
        <h1 className="text-xl font-bold font-serif text-muk tracking-wide">{t('lab.title')}</h1>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col relative z-10 px-6 overflow-y-auto pb-[calc(80px+env(safe-area-inset-bottom))] md:pb-6 no-scrollbar">
        {isLoading ? (
          // 카드 형태의 스켈레톤(스피너 대체) — 장소명 + 시각 + 칩 줄 레이아웃을 암시한다.
          <div className="flex flex-col gap-4 mt-2 md:max-w-2xl md:mx-auto md:w-full" aria-hidden>
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="bg-white border border-line rounded-3xl p-5 shadow-[0_2px_14px_rgba(43,35,32,0.06)] animate-pulse"
              >
                <div className="h-5 bg-hanji-deep w-2/5 rounded-md mb-2" />
                <div className="h-3 bg-hanji-deep w-1/3 rounded-md mb-4" />
                <div className="flex flex-wrap gap-2">
                  <div className="h-8 bg-hanji-deep w-24 rounded-full" />
                  <div className="h-8 bg-hanji-deep w-28 rounded-full" />
                  <div className="h-8 bg-hanji-deep w-20 rounded-full" />
                </div>
              </div>
            ))}
          </div>
        ) : hasError ? (
          // Error State — 401(needsAuth)이면 '다시 시도'가 성공할 수 없으므로 지도로 유도한다.
          <div className="flex-1 flex items-center justify-center">
            <div className="bg-white border border-line rounded-3xl p-8 flex flex-col items-center text-center w-full max-w-[320px] shadow-[0_2px_14px_rgba(43,35,32,0.06)]">
              <div className="w-16 h-16 rounded-full bg-terracotta/10 border border-terracotta/20 flex items-center justify-center mb-6">
                <AlertCircle className="text-terracotta" size={32} />
              </div>
              <p className="text-muk-soft text-sm leading-relaxed mb-8 px-2">{t('lab.loadError')}</p>
              {needsAuth ? (
                <button
                  type="button"
                  onClick={() => router.push('/main')}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gold hover:bg-gold-deep text-white text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
                >
                  <Compass size={18} className="text-white" />
                  <span>{t('nav.home')}</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => { retriedRef.current = true; void loadPending(); }}
                  className="px-5 py-2.5 rounded-xl bg-gold hover:bg-gold-deep text-white text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
                >
                  {t('common.retry')}
                </button>
              )}
            </div>
          </div>
        ) : items.length === 0 ? (
          // Empty State — 거절 기록이 없거나 모두 답변한 정상 상태.
          <div className="flex-1 flex items-center justify-center">
            <div className="bg-white border border-line rounded-3xl p-8 flex flex-col items-center text-center w-full max-w-[320px] shadow-[0_2px_14px_rgba(43,35,32,0.06)]">
              <div className="w-16 h-16 rounded-full bg-gradient-to-b from-gold/20 to-gold/10 border border-line flex items-center justify-center mb-6">
                <FlaskConical className="text-gold" size={32} />
              </div>
              <h2 className="text-xl font-bold font-serif text-muk mb-3">{t('lab.empty')}</h2>
              <p className="text-muk-soft text-sm leading-relaxed px-2">{t('lab.emptyDesc')}</p>
            </div>
          </div>
        ) : (
          // List State
          <div className="flex flex-col gap-4 mt-2 md:max-w-2xl md:mx-auto md:w-full">
            <p className="text-sm text-muk-soft px-1 leading-relaxed">{t('lab.cardDesc')}</p>

            {items.map((item) => {
              const typeLabel = item.facilityType && TYPE_IDS.includes(item.facilityType)
                ? t(`category.${item.facilityType}`)
                : item.facilityType;
              const when = formatRecommendedAt(item.recommendedAt, locale);
              const noteOpen = noteFor === item.feedbackId;
              const busy = busyId === item.feedbackId;
              return (
                <div
                  key={item.feedbackId}
                  className={`bg-white border border-line rounded-3xl p-5 shadow-[0_2px_14px_rgba(43,35,32,0.06)] transition-opacity ${busy ? 'opacity-60' : ''}`}
                >
                  {/* 장소명 + 유형 + 목록에서 제거 */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h2 className="text-lg font-bold font-serif text-muk break-words">{item.facilityName}</h2>
                        {typeLabel && (
                          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-md bg-jade/12 text-jade border border-jade/25">
                            {typeLabel}
                          </span>
                        )}
                      </div>
                      {when && (
                        <p className="text-xs text-muk-soft mt-1">{t('lab.recommendedAt')} · {when}</p>
                      )}
                    </div>
                    <button
                      type="button"
                      aria-label={t('lab.hide')}
                      disabled={busy}
                      onClick={() => void mutate(item.feedbackId, () => hideLabItem(item.feedbackId), 'lab.hidden')}
                      className="shrink-0 text-muk-soft hover:text-muk disabled:opacity-50 transition-colors rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
                    >
                      <X size={18} />
                    </button>
                  </div>

                  {/* 이유 칩 9종 — 선택 즉시 답변 처리(기타만 메모 입력을 연다). */}
                  <div className="flex flex-wrap gap-2 mt-4">
                    {REASON_CODES.map((code) => {
                      const selected = code === 'other' && noteOpen;
                      return (
                        <button
                          key={code}
                          type="button"
                          disabled={busy}
                          aria-pressed={selected}
                          aria-label={t(`lab.reason.${code}`)}
                          onClick={() => handleReason(item, code)}
                          className={`px-3 py-1.5 rounded-full border text-xs font-medium transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 ${
                            selected
                              ? 'bg-gold text-white border-gold'
                              : 'bg-hanji border-line text-muk hover:bg-hanji-deep hover:border-gold/40'
                          }`}
                        >
                          {t(`lab.reason.${code}`)}
                        </button>
                      );
                    })}
                  </div>

                  {/* '기타' 선택 시에만 노출되는 메모 입력(선택 입력 — 비워도 보낼 수 있다). */}
                  {noteOpen && (
                    <div className="mt-4 animate-fade-in">
                      <label
                        htmlFor={`lab-note-${item.feedbackId}`}
                        className="block text-sm font-semibold text-muk-soft mb-2"
                      >
                        {t('lab.noteLabel')}
                      </label>
                      <textarea
                        id={`lab-note-${item.feedbackId}`}
                        value={noteText}
                        onChange={(e) => setNoteText(e.target.value)}
                        placeholder={t('lab.notePlaceholder')}
                        maxLength={NOTE_MAX}
                        rows={3}
                        className="w-full bg-hanji border border-line text-muk placeholder:text-muk-soft/70 rounded-xl p-3 text-sm outline-none focus:border-gold transition-colors resize-none"
                      />
                      <div className="flex items-center justify-between gap-3 mt-2">
                        <span className="text-[11px] text-muk-soft tabular-nums">{noteText.length}/{NOTE_MAX}</span>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handleNoteSubmit(item)}
                          className="px-4 py-2 rounded-xl bg-gold hover:bg-gold-deep disabled:opacity-50 text-white text-sm font-bold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
                        >
                          {t('lab.noteSubmit')}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* 건너뛰기 — 학습 없이 이 항목만 목록에서 빼낸다(reason_status='skipped'). */}
                  <div className="flex justify-end mt-4 pt-3 border-t border-line">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void mutate(item.feedbackId, () => skipLabItem(item.feedbackId), 'lab.skipped')}
                      className="text-xs font-semibold text-muk-soft hover:text-muk disabled:opacity-50 transition-colors px-2 py-1 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
                    >
                      {t('lab.skip')}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
