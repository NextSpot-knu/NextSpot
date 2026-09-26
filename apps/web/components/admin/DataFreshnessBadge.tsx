'use client';

import { useState, useEffect } from 'react';
import { Clock, Satellite } from 'lucide-react';
import { createPublicClient } from '@/lib/supabase';
import { apiClient } from '@/lib/api-client';
// 상대시간 표기는 lib/freshness.ts 단일 소스로 수렴(과거 이 파일의 내부 formatRelative 중복 제거).
import { formatRelativeKo } from '@/lib/freshness';
import { BASIS_BADGE } from '@/lib/adminPredictedView';

// 데이터 신선도 배지 — 최신 congestion_logs.timestamp 를 1건 조회해
// "데이터 갱신 N분 전" 형태로 관제 데이터가 얼마나 최신인지 헤더에 노출한다(D5 지속성 가시화).
// TourAPI 동기화 신선도도 인접 배지로 함께 표기한다(이력 없으면 '동기화 이력 없음' — 관리자에겐 정직하게 노출).
// 정적 export 앱이라 서버 라우트 없이 anon 공개 읽기(RLS anon_select_*)로 supabase-js 직접 호출.
// 정직성 원칙: 로그가 없거나 조회가 실패하면 "데이터 없음"으로 표기해, 실패를 신선한 것처럼 위장하지 않는다.
//
// 2026-09-22 예측 모드: 세 번째 칩(congestionBasis)은 오늘 시설 혼잡 지표가 실측/추정/예측 중 무엇인지 —
// 페이지가 판정해 넘긴다. 이 배지는 관리자 API 를 부르지 않는다(대시보드 첫 로드의 무거운 관리자 조회 수를
// 늘리지 않는다 — 512MB 인스턴스의 memory_guard 동시성 2 를 이 배지가 차지하지 않게).

/** 48시간보다 오래된 제보는 상대시간('31일 전') 대신 짧은 날짜로 적는다(2026-09-21 PM 지적). */
const STALE_RELATIVE_CUTOFF_MS = 48 * 60 * 60 * 1000;

export function DataFreshnessBadge({
  congestionBasis = null,
}: {
  /** 오늘 시설 혼잡 지표의 근거 — 페이지의 판정(실측/추정/예측). null 이면 칩을 그리지 않는다(기존 두 칩 그대로). */
  congestionBasis?: 'measured' | 'estimate' | 'predicted' | null;
} = {}) {
  const [latest, setLatest] = useState<Date | null>(null);
  const [failed, setFailed] = useState(false);
  // 최신 제보가 48시간보다 오래됐는가 — 응답이 도착한 순간 한 번 판정한다(렌더마다 시계를 읽지 않는다).
  const [congestionStale, setCongestionStale] = useState(false);
  // TourAPI 마지막 동기화 시각 — undefined=조회 중, null=이력 없음/조회 실패(정직 노출), Date=정상.
  const [tourapiSync, setTourapiSync] = useState<Date | null | undefined>(undefined);

  useEffect(() => {
    let active = true; // 언마운트 이후 setState 방지 가드
    const supabase = createPublicClient();
    supabase
      .from('congestion_logs')
      .select('timestamp')
      .order('timestamp', { ascending: false })
      .limit(1)
      .then(({ data, error }) => {
        if (!active) return;
        const rows = data as { timestamp: string | null }[] | null;
        const ts = rows && rows.length > 0 ? rows[0].timestamp : null;
        // 조회 실패·로그 없음·빈 타임스탬프 → 신선한 것으로 위장하지 않고 '데이터 없음'.
        if (error || !ts) {
          setFailed(true);
          return;
        }
        const parsed = new Date(ts);
        if (Number.isNaN(parsed.getTime())) {
          setFailed(true);
          return;
        }
        setLatest(parsed);
        setCongestionStale(Date.now() - parsed.getTime() > STALE_RELATIVE_CUTOFF_MS);
      });
    return () => {
      active = false;
    };
  }, []);

  // TourAPI 동기화 시각 — 1순위 백엔드 /freshness, 실패 시 anon supabase 로 TourAPI 적재분
  // (contentid 존재)의 updated_at 최대 1건을 추정 폴백. 둘 다 없으면 '동기화 이력 없음'.
  useEffect(() => {
    let active = true;
    const toDateOrNull = (ts: string | null | undefined): Date | null => {
      if (!ts) return null;
      const d = new Date(ts);
      return Number.isNaN(d.getTime()) ? null : d; // 파싱 불가를 신선한 것으로 위장하지 않음
    };
    (async () => {
      try {
        const res = await apiClient.getFreshness();
        if (!active) return;
        setTourapiSync(toDateOrNull(res?.lastTourapiSync));
        return; // 백엔드가 응답했으면(이력 없음 포함) 그 판정을 신뢰 — 폴백 안 함
      } catch {
        /* 백엔드 미기동/네트워크 실패 → 아래 supabase 추정 폴백 */
      }
      try {
        const supabase = createPublicClient();
        const { data, error } = await supabase
          .from('facilities')
          .select('updated_at')
          .not('contentid', 'is', null)
          .order('updated_at', { ascending: false })
          .limit(1);
        if (!active) return;
        const rows = data as { updated_at: string | null }[] | null;
        const ts = !error && rows && rows.length > 0 ? rows[0].updated_at : null;
        setTourapiSync(toDateOrNull(ts));
      } catch {
        if (active) setTourapiSync(null);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // 관광공사 동기화 배지 — 조회 중이면 렌더 보류. 출처 표기 규정(ⓒ한국관광공사, bare 'TourAPI' 지양)
  // 과 no-defensive-copy(고백형 '이력 없음' 대신 상태어) 를 함께 지킨다.
  const tourapiBadge =
    tourapiSync === undefined ? null : tourapiSync === null ? (
      <span
        title="동기화 이력을 조회하지 못했습니다 — 다음 정기 동기화에서 갱신됩니다."
        className="flex items-center gap-1.5 px-2.5 py-1 bg-hanok-card border border-hanok-line text-hanok-muted rounded-full text-xs font-bold"
      >
        <Satellite size={14} />
        ⓒ한국관광공사 동기화 대기
      </span>
    ) : (
      <span
        title={`ⓒ한국관광공사 데이터 마지막 동기화: ${tourapiSync.toLocaleString()}`}
        className="flex items-center gap-1.5 px-2.5 py-1 bg-hanok-card border border-hanok-line text-hanok-muted rounded-full text-xs font-bold"
      >
        <Satellite size={14} />
        ⓒ한국관광공사 동기화 {formatRelativeKo(tourapiSync)}
      </span>
    );

  // 현장 제보 배지 — congestion_logs 는 '현장 혼잡 제보' 스트림이다. 일반명사 '데이터 갱신'으로
  // 표기하면 이 한 스트림의 나이가 플랫폼 전체의 신선도처럼 읽힌다(관광공사 동기화는 매일,
  // 주차 관측은 10분 주기인데 "데이터 갱신 31일 전"으로 보이는 왜곡 — 2026-09-21 PM 지적).
  // 스트림 이름을 명시하고, 48시간보다 오래된 제보는 '31일 전' 같은 상대시간 대신 짧은 날짜로
  // 표기한다(정확한 시각은 툴팁 유지 — 사실 은폐 아님, 과대 표기 제거).
  // stale 판정은 응답 도착 시 상태(congestionStale)로 굳혔다 — 렌더는 시계를 읽지 않는다.
  const congestionLabel = (d: Date) =>
    congestionStale ? `${d.getMonth() + 1}/${d.getDate()}` : formatRelativeKo(d);
  const congestionBadge = failed ? (
    <span
      title="최신 현장 제보를 가져오지 못했습니다 — 조회를 다시 시도합니다."
      className="flex items-center gap-1.5 px-2.5 py-1 bg-hanok-card border border-hanok-line text-hanok-muted rounded-full text-xs font-bold"
    >
      <Clock size={14} />
      현장 제보 수집 중
    </span>
  ) : !latest ? (
    <span
      title="데이터 신선도 확인 중 — 최신 현장 제보 조회 대기"
      className="flex items-center gap-1.5 px-2.5 py-1 bg-hanok-card border border-hanok-line text-hanok-muted rounded-full text-xs font-bold"
    >
      <Clock size={14} />
      신선도 확인 중
    </span>
  ) : (
    <span
      title={`최신 현장 혼잡 제보 시각: ${latest.toLocaleString()}`}
      className="flex items-center gap-1.5 px-2.5 py-1 bg-hanok-card border border-hanok-line text-hanok-muted rounded-full text-xs font-bold"
    >
      <Clock size={14} />
      현장 제보 {congestionLabel(latest)}
    </span>
  );

  // 오늘 지표 근거 칩 — 추정은 하늘 점선, 예측은 보라 점선, 실측은 중립(페이지의 배지 색 규약과 같다).
  const basisBadge =
    congestionBasis === null ? null : congestionBasis === 'measured' ? (
      <span
        title="오늘 시설 혼잡 지표는 현장 관측(손님 제보 · 사장 좌석 방송) 기반 실측입니다"
        className="flex items-center gap-1.5 px-2.5 py-1 bg-hanok-card border border-hanok-line text-hanok-muted rounded-full text-xs font-bold"
      >
        오늘 지표 · {BASIS_BADGE.measured}
      </span>
    ) : congestionBasis === 'estimate' ? (
      <span
        title="공영주차 실측 + 관광공사 집중률 기반 추정 — 현장 관측이 들어오면 실측으로 전환됩니다"
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-black border border-dashed bg-sky-500/15 text-sky-700 border-sky-400/60"
      >
        오늘 지표 · {BASIS_BADGE.estimate}
      </span>
    ) : (
      <span
        title="업종 시간대 패턴 기반 예측 — 공영주차 실측이 쌓이면 추정으로, 현장 관측이 들어오면 실측으로 전환됩니다"
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-black border border-dashed bg-violet-500/15 text-violet-700 border-violet-400/60"
      >
        오늘 지표 · {BASIS_BADGE.predicted}
      </span>
    );

  return (
    <span className="flex items-center gap-2">
      {congestionBadge}
      {tourapiBadge}
      {basisBadge}
    </span>
  );
}
