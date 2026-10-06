'use client';

// 한국관광공사 TourAPI 출처 칩 하나(계획 B3 · P8). /main 에 흩어져 있던 두 개의 10px 반투명 출처 알약을 대신한다.
// 공모전 규정: 공사 데이터가 흐르는 화면에는 'ⓒ한국관광공사' 출처 텍스트가 항상 보인다. 공공기관을 운영 주체처럼
// 쓰지 않는다 — '출처:' 텍스트 표기만(PM 규칙). 동기화 시각을 모르면 시각을 지어내지 않고 출처만 쓴다.
import { useT } from '@/lib/i18n/I18nProvider';
import { relativeParts } from '@/lib/freshness';

interface SourceCreditProps {
  /** 마지막 TourAPI 동기화 시각(ISO). 없으면 출처만. */
  syncedAt?: string | null;
  /** 좁은 자리(휴대폰 머리) — 시각을 빼고 출처만. */
  compact?: boolean;
  className?: string;
}

export function SourceCredit({ syncedAt = null, compact = false, className = '' }: SourceCreditProps) {
  const t = useT();
  const parts = !compact && syncedAt ? relativeParts(syncedAt) : null;
  const text = parts
    ? t('credit.tourapiSynced', {
        rel:
          parts.unit === 'now' ? t('freshness.justNow')
          : parts.unit === 'min' ? t('freshness.minAgo', { n: parts.value })
          : parts.unit === 'hour' ? t('freshness.hourAgo', { n: parts.value })
          : t('freshness.dayAgo', { n: parts.value }),
      })
    : t('credit.tourapi');
  return (
    <span
      data-testid="source-credit"
      title={text}
      className={`inline-flex items-center rounded-full border border-line bg-white px-2.5 font-semibold text-muk-soft ${compact ? 'py-[3px] text-[10px] leading-none' : 'py-1 text-[11px] leading-tight'} ${className}`}
    >
      {text}
    </span>
  );
}

export default SourceCredit;
