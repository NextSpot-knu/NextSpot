'use client';

import { useState, useEffect } from 'react';
import { Clock, Satellite } from 'lucide-react';
import { createPublicClient } from '@/lib/supabase';
import { apiClient } from '@/lib/api-client';
// 상대시간 표기는 lib/freshness.ts 단일 소스로 수렴(과거 이 파일의 내부 formatRelative 중복 제거).
import { formatRelativeKo } from '@/lib/freshness';

// 데이터 신선도 배지 — 최신 congestion_logs.timestamp 를 1건 조회해
// "데이터 갱신 N분 전" 형태로 관제 데이터가 얼마나 최신인지 헤더에 노출한다(D5 지속성 가시화).
// TourAPI 동기화 신선도도 인접 배지로 함께 표기한다(이력 없으면 '동기화 이력 없음' — 관리자에겐 정직하게 노출).
// 정적 export 앱이라 서버 라우트 없이 anon 공개 읽기(RLS anon_select_*)로 supabase-js 직접 호출.
// 정직성 원칙: 로그가 없거나 조회가 실패하면 "데이터 없음"으로 표기해, 실패를 신선한 것처럼 위장하지 않는다.

export function DataFreshnessBadge() {
  const [latest, setLatest] = useState<Date | null>(null);
  const [failed, setFailed] = useState(false);
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

  // TourAPI 동기화 배지 — 조회 중이면 렌더 보류, 이력 없음/실패는 명시 표기(관리자에겐 정직하게).
  const tourapiBadge =
    tourapiSync === undefined ? null : tourapiSync === null ? (
      <span
        title="TourAPI 동기화 이력을 찾지 못했습니다 — 인제스트가 아직 실행되지 않았거나 조회에 실패했습니다."
        className="flex items-center gap-1.5 px-2.5 py-1 bg-hanok-card border border-hanok-line text-hanok-muted rounded-full text-xs font-bold"
      >
        <Satellite size={14} />
        TourAPI 동기화 이력 없음
      </span>
    ) : (
      <span
        title={`TourAPI 마지막 동기화 시각 기준: ${tourapiSync.toLocaleString()}`}
        className="flex items-center gap-1.5 px-2.5 py-1 bg-hanok-card border border-hanok-line text-hanok-muted rounded-full text-xs font-bold"
      >
        <Satellite size={14} />
        TourAPI 동기화 {formatRelativeKo(tourapiSync)}
      </span>
    );

  // 혼잡 로그 배지 — 조회 실패/로그 없음은 '데이터 없음' 중립 상태로 자리 유지(정직성),
  // 응답 전(로딩)엔 헤더에서 증발하지 않도록 중립 배지로 자리 유지.
  const congestionBadge = failed ? (
    <span
      title="최신 혼잡 로그를 가져오지 못했습니다 — congestion_logs 가 비어있거나 조회에 실패했습니다."
      className="flex items-center gap-1.5 px-2.5 py-1 bg-hanok-card border border-hanok-line text-hanok-muted rounded-full text-xs font-bold"
    >
      <Clock size={14} />
      데이터 없음
    </span>
  ) : !latest ? (
    <span
      title="데이터 신선도 확인 중 — 최신 혼잡 로그 조회 대기"
      className="flex items-center gap-1.5 px-2.5 py-1 bg-hanok-card border border-hanok-line text-hanok-muted rounded-full text-xs font-bold"
    >
      <Clock size={14} />
      신선도 확인 중
    </span>
  ) : (
    <span
      title={`최신 혼잡 로그 시각 기준: ${latest.toLocaleString()}`}
      className="flex items-center gap-1.5 px-2.5 py-1 bg-hanok-card border border-hanok-line text-hanok-muted rounded-full text-xs font-bold"
    >
      <Clock size={14} />
      데이터 갱신 {formatRelativeKo(latest)}
    </span>
  );

  return (
    <span className="flex items-center gap-2">
      {congestionBadge}
      {tourapiBadge}
    </span>
  );
}
