'use client';

// 누적 임팩트 카드 — /mypage 최상단의 한 줄 성적표.
//   "누적 분산 유도 N건 · 절약된 대기 M분 · 참여 점포 K곳"
//
// 왜 이 자리인가: 이 서비스가 무엇을 해냈는지 말하는 숫자는 지금까지 /mypage/impact 안쪽에만
// 있었고, 그 페이지는 로그인·집계가 없으면 에러/빈 화면으로 떨어졌다. 3분만 둘러보는 사람에게
// 서비스의 성과가 한 번도 보이지 않는 구조였다.
//
// 데이터 출처(정직성):
//   · GET /api/v1/impact/summary (인증 필요) — 성공하고 값이 0 이 아니면 **실집계**를 그대로 쓴다.
//     accepted → 분산 유도, wait_saved_minutes → 절약된 대기.
//   · 401(비로그인)·서버 미가용·전부 0(신규 사용자) → 숫자를 숨기지 않고 **예시 값**을 쓰되
//     '실증 준비 중 · 예시 값' 배지를 항상 함께 띄운다. 빈 카드보다 정직한 예시가 낫다는 판단이고,
//     배지가 없으면 실집계로 오인되므로 배지는 이 카드의 필수 부품이다.
//   · 참여 점포 수는 임팩트 API 계약에 없다(백엔드 ImpactSummaryResponse 5필드 확인). 그래서
//     이 항목만은 언제나 예시 값이며, 실집계 모드에서도 '예시' 꼬리표를 따로 붙인다.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronRight, Sparkles } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { DEMO_ADMIN_KPI } from '@/lib/demoFixtures';
import { useT } from '@/lib/i18n/I18nProvider';

// 예시 값 — 관제 데모 콘솔이 쓰는 상수를 **그대로 읽는다**(복제하지 않는다).
// 숫자를 베껴 두면 한쪽만 고쳐졌을 때 심사위원이 두 화면에서 다른 성과를 보고 어느 쪽도 믿지 못한다.
const SAMPLE_DISPERSALS = DEMO_ADMIN_KPI.dispersals;
const SAMPLE_SAVED_WAIT_MINUTES = DEMO_ADMIN_KPI.savedWaitMinutes;
/** 참여 점포 수 — 임팩트 API 가 내려주지 않는 항목이라 항상 예시 값이다. */
const SAMPLE_PARTICIPATING_STORES = DEMO_ADMIN_KPI.participatingStores;

interface ImpactNumbers {
  dispersals: number;
  savedWaitMinutes: number;
  stores: number;
  /** true 면 '실증 준비 중 · 예시 값' 배지를 띄운다. */
  sample: boolean;
}

export default function ImpactSummaryCard() {
  const router = useRouter();
  const t = useT();
  // null = 아직 조회 중(스켈레톤). 조회가 끝나면 실집계든 예시든 **반드시** 숫자가 생긴다.
  const [numbers, setNumbers] = useState<ImpactNumbers | null>(null);

  // 첫 실패는 익명 세션 부트스트랩(SessionBootstrap) 완료 전 레이스일 수 있어 2.5초 유예 1회만
  // 재시도한다(/mypage·/mypage/impact 의 기존 패턴과 동일). 유한 재시도라 무한 스켈레톤이 아니다.
  const retriedRef = useRef(false);
  const aliveRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const d = await apiClient.get('/api/v1/impact/summary');
      const dispersals = Math.max(0, Math.round(Number(d?.accepted) || 0));
      const savedWaitMinutes = Math.max(0, Math.round(Number(d?.waitSavedMinutes) || 0));
      if (!aliveRef.current) return;
      // 전부 0(신규 사용자)이면 실집계가 있어도 보여 줄 성과가 없다 — 예시 모드로 내려간다.
      const empty = dispersals === 0 && savedWaitMinutes === 0;
      setNumbers(
        empty
          ? {
              dispersals: SAMPLE_DISPERSALS,
              savedWaitMinutes: SAMPLE_SAVED_WAIT_MINUTES,
              stores: SAMPLE_PARTICIPATING_STORES,
              sample: true,
            }
          : { dispersals, savedWaitMinutes, stores: SAMPLE_PARTICIPATING_STORES, sample: false },
      );
    } catch {
      if (!retriedRef.current) {
        retriedRef.current = true;
        setTimeout(() => { void load(); }, 2500);
        return; // 스켈레톤 유지
      }
      if (!aliveRef.current) return;
      // 401(비로그인)·서버 미가용 — 빈 카드 대신 예시 값 + 배지.
      setNumbers({
        dispersals: SAMPLE_DISPERSALS,
        savedWaitMinutes: SAMPLE_SAVED_WAIT_MINUTES,
        stores: SAMPLE_PARTICIPATING_STORES,
        sample: true,
      });
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void load();
    return () => { aliveRef.current = false; };
  }, [load]);

  if (!numbers) {
    return (
      <div
        className="mb-4 h-[104px] w-full animate-pulse rounded-3xl border border-line bg-white/70 shadow-[0_2px_14px_rgba(43,35,32,0.06)]"
        aria-hidden
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => router.push('/mypage/impact')}
      // aria 는 두 모드 공통 — 이 버튼이 여는 곳(누적 임팩트 상세)은 예시 모드에서도 같다.
      aria-label={t('impact.summaryAria')}
      className="group mb-4 w-full rounded-3xl border border-gold/35 bg-gradient-to-r from-gold/15 via-hanji to-jade/10 p-5 text-left shadow-[0_2px_14px_rgba(43,35,32,0.06)] toss-pressable hover:border-gold/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {/* 제목은 두 모드 같다 — 이 버튼의 aria 와 이 버튼이 여는 /mypage/impact 가 '누적 임팩트'라
                부르는 숫자를 카드에서만 다르게 부르면 한 숫자가 두 이름을 갖는다. 예시 모드는 아래 배지가 말한다. */}
            <span className="inline-flex items-center gap-1.5 text-[13px] font-bold text-muk">
              <Sparkles size={16} className="text-gold-deep" aria-hidden />
              {t('impact.summaryTitle')}
            </span>
            {/* 예시 값임을 숨기지 않는다 — 이 배지가 없으면 실집계로 오인된다. */}
            {numbers.sample && (
              <span className="rounded-full border border-terracotta/30 bg-terracotta/10 px-2 py-0.5 text-[10px] font-bold text-terracotta">
                {t('impact.sampleBadge')}
              </span>
            )}
          </div>
          {/* 세 숫자 — 한 줄로 읽히되 각 값은 굵게 세운다. */}
          <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <Metric text={t('impact.summaryDispersals', { n: numbers.dispersals.toLocaleString() })} />
            <span className="text-muk-soft/60" aria-hidden>·</span>
            <Metric text={t('impact.summarySavedWait', { n: numbers.savedWaitMinutes.toLocaleString() })} />
            <span className="text-muk-soft/60" aria-hidden>·</span>
            <Metric text={t('impact.summaryStores', { n: numbers.stores.toLocaleString() })} />
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muk-soft">
            {numbers.sample ? t('impact.summarySampleNote') : t('impact.summaryRealNote')}
          </p>
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
