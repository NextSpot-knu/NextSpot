'use client';

import { useState, useEffect } from 'react';
import { Clock } from 'lucide-react';
import { createPublicClient } from '@/lib/supabase';

// 데이터 신선도 배지 — 최신 congestion_logs.timestamp 를 1건 조회해
// "데이터 갱신 N분 전" 형태로 관제 데이터가 얼마나 최신인지 헤더에 노출한다(D5 지속성 가시화).
// 정적 export 앱이라 서버 라우트 없이 anon 공개 읽기(RLS anon_select_*)로 supabase-js 직접 호출.
// 정직성 원칙: 로그가 없거나 조회가 실패하면 "데이터 없음"으로 표기해, 실패를 신선한 것처럼 위장하지 않는다.

// 최신 로그 시각과 현재시각의 차이를 사람이 읽는 상대시간으로 환산.
// 미래 타임스탬프(음수 차이)는 '방금 전'으로 안전하게 수렴한다.
function formatRelative(from: Date): string {
  const diffMin = Math.floor((Date.now() - from.getTime()) / 60000);
  if (diffMin < 1) return '방금 전';
  if (diffMin < 60) return `${diffMin}분 전`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}시간 전`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}일 전`;
}

export function DataFreshnessBadge() {
  const [latest, setLatest] = useState<Date | null>(null);
  const [failed, setFailed] = useState(false);

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

  // 조회 실패 또는 로그 없음 — 배지를 지우지 않고 '데이터 없음' 중립 상태로 자리 유지(정직성).
  if (failed) {
    return (
      <span
        title="최신 혼잡 로그를 가져오지 못했습니다 — congestion_logs 가 비어있거나 조회에 실패했습니다."
        className="flex items-center gap-1.5 px-2.5 py-1 bg-hanok-card border border-hanok-line text-hanok-muted rounded-full text-xs font-bold"
      >
        <Clock size={14} />
        데이터 없음
      </span>
    );
  }

  // 응답 전(로딩) — null 반환으로 헤더에서 증발하지 않도록 중립 배지로 자리 유지.
  if (!latest) {
    return (
      <span
        title="데이터 신선도 확인 중 — 최신 혼잡 로그 조회 대기"
        className="flex items-center gap-1.5 px-2.5 py-1 bg-hanok-card border border-hanok-line text-hanok-muted rounded-full text-xs font-bold"
      >
        <Clock size={14} />
        신선도 확인 중
      </span>
    );
  }

  // 정상 — 최신 congestion_logs.timestamp 기준 상대시간 표시.
  return (
    <span
      title={`최신 혼잡 로그 시각 기준: ${latest.toLocaleString()}`}
      className="flex items-center gap-1.5 px-2.5 py-1 bg-hanok-card border border-hanok-line text-hanok-muted rounded-full text-xs font-bold"
    >
      <Clock size={14} />
      데이터 갱신 {formatRelative(latest)}
    </span>
  );
}
