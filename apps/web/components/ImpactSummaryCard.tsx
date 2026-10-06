'use client';

// 나의 여행 임팩트 카드 — /mypage 최상단의 한 줄 성적표.
//   "대안으로 이동 N번 · 아낀 대기 M분"
//
// 데이터 출처: GET /api/v1/impact/summary (인증 필요) — accepted → 대안으로 이동, wait_saved_minutes → 아낀 대기.
//
// **실제 기록이 있을 때만 그린다.** 조회 중·401(비로그인)·서버 미가용·전부 0(신규 사용자)이면 아무것도
// 그리지 않는다. 예전에는 그 경우 관제 데모 숫자(312건 · 1,240분 · 14곳)를 '예시 값' 배지와 함께 보여 줬는데,
// 방문 0 인 사람에게 '나의' 성과가 붙어 지어낸 숫자로 읽혔다(2026-10-06 감사 I18, PM 결정 4.19a — 09-21
// '짧게 둘러보는 사람에게 예시를 보여 준다'를 되돌린다). 첫 화면의 출발점은 바로 아래 프로필 열의
// '지금부터 아낀 시간이 쌓입니다' 카드가 맡는다. 서비스 전체 성과는 관제 데모 콘솔에만 둔다.
// '참여 점포' 는 임팩트 API 계약에 없는(언제나 예시인) 항목이라 개인 화면에서 뺐다.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronRight, Sparkles } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { useT } from '@/lib/i18n/I18nProvider';

interface ImpactNumbers {
  dispersals: number;
  savedWaitMinutes: number;
}

export default function ImpactSummaryCard() {
  const router = useRouter();
  const t = useT();
  // null = 조회 중이거나 보여 줄 실제 기록이 없다 — 둘 다 아무것도 그리지 않는다.
  const [numbers, setNumbers] = useState<ImpactNumbers | null>(null);

  // 첫 실패는 익명 세션 부트스트랩(SessionBootstrap) 완료 전 레이스일 수 있어 2.5초 유예 1회만
  // 재시도한다(/mypage·/mypage/impact 의 기존 패턴과 동일).
  const retriedRef = useRef(false);
  const aliveRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const d = await apiClient.get('/api/v1/impact/summary');
      const dispersals = Math.max(0, Math.round(Number(d?.accepted) || 0));
      const savedWaitMinutes = Math.max(0, Math.round(Number(d?.waitSavedMinutes) || 0));
      if (!aliveRef.current) return;
      // 전부 0(신규 사용자)이면 보여 줄 성과가 없다 — 카드를 그리지 않는다.
      setNumbers(dispersals === 0 && savedWaitMinutes === 0 ? null : { dispersals, savedWaitMinutes });
    } catch {
      if (!retriedRef.current) {
        retriedRef.current = true;
        setTimeout(() => { void load(); }, 2500);
      }
      // 401(비로그인)·서버 미가용 — 숫자를 지어내지 않고 카드를 그리지 않는다.
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void load();
    return () => { aliveRef.current = false; };
  }, [load]);

  if (!numbers) return null;

  return (
    <button
      type="button"
      onClick={() => router.push('/mypage/impact')}
      aria-label={t('impact.summaryAria')}
      className="group mb-4 w-full rounded-3xl border border-gold/35 bg-gradient-to-r from-gold/15 via-hanji to-jade/10 p-5 text-left shadow-[0_2px_14px_rgba(43,35,32,0.06)] toss-pressable hover:border-gold/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="inline-flex items-center gap-1.5 text-[13px] font-bold text-muk">
            <Sparkles size={16} className="text-gold-deep" aria-hidden />
            {t('impact.summaryTitle')}
          </span>
          {/* 두 숫자 — 한 줄로 읽히되 각 값은 굵게 세운다. */}
          <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <Metric text={t('impact.summaryDispersals', { n: numbers.dispersals.toLocaleString() })} />
            <span className="text-muk-soft/60" aria-hidden>·</span>
            <Metric text={t('impact.summarySavedWait', { n: numbers.savedWaitMinutes.toLocaleString() })} />
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muk-soft">{t('impact.summaryRealNote')}</p>
        </div>
        <ChevronRight
          size={20}
          className="mt-0.5 shrink-0 text-gold-deep transition-transform group-hover:translate-x-0.5"
          aria-hidden
        />
      </div>
    </button>
  );
}

// 숫자와 라벨을 한 문장으로 받는다(로케일마다 어순이 달라 조각으로 나누면 번역이 깨진다).
function Metric({ text }: { text: string }) {
  return <span className="whitespace-nowrap text-[15px] font-black text-muk tabular-nums">{text}</span>;
}
