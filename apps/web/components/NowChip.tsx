'use client';

// 현재 시각 칩 — "현재 14:32 기준". 도착 예정시각·예측 대기 등 시간 기준 수치가 있는 화면에서
// "이 숫자들이 어느 시점 기준인지"를 명시해 혼동을 막는다(예: 새벽 리허설 때 '02:31 도착 예정'이
// 버그로 오인된 사례). 정적 export(SSR) 안전: 서버 렌더와 클라이언트 시각이 어긋나므로
// 마운트 후에만 시각을 그린다(마운트 전엔 자리 유지용 투명 상태 — 하이드레이션 불일치 방지).
import { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';
import { useT } from '@/lib/i18n/I18nProvider';

export default function NowChip({ className = '' }: { className?: string }) {
  const t = useT();
  const [now, setNow] = useState<string | null>(null);

  useEffect(() => {
    const fmt = () => {
      const d = new Date();
      setNow(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
    };
    fmt();
    // 30초 간격 갱신 — 분 단위 표시라 충분하고, 타이머 부하 최소화. 언마운트 시 정리.
    const id = setInterval(fmt, 30_000);
    return () => clearInterval(id);
  }, []);

  if (!now) return null; // 마운트 전(서버 렌더 포함)에는 그리지 않음

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full bg-hanji-deep/70 border border-line px-2 py-0.5 text-[10px] font-medium text-muk-soft whitespace-nowrap ${className}`}
    >
      <Clock size={11} aria-hidden />
      {t('common.nowTime', { time: now })}
    </span>
  );
}
