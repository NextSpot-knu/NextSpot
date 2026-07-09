'use client';

import { Bell, BellOff, BellRing } from 'lucide-react';
import { useCongestionAlerts } from '@/lib/useCongestionAlerts';
import { useT } from '@/lib/i18n/I18nProvider';

/**
 * 혼잡 알림 옵트인 토글 — "🔔 한산해지면 알림 받기".
 *
 * 저장한 장소가 한산해지면 브라우저 로컬 알림을 받는다. 권한 상태(default/granted/denied)와
 * on/off 를 반영하며, Notification 미지원 환경에서는 비활성 안내로 자연스럽게 대체된다.
 * 한지 라이트 팔레트(gold/jade/muk/hanji) + 접근성(aria-pressed, focus-visible) 준수.
 */
export function CongestionAlertToggle({ className = '' }: { className?: string }) {
  const { enabled, permission, supported, toggle } = useCongestionAlerts();
  const t = useT();

  // 미지원: 조용히 비활성 안내(정직성 — 되지 않는 버튼을 켜진 것처럼 보이지 않게)
  if (!supported) {
    return (
      <div
        className={`flex items-center gap-2.5 rounded-2xl border border-line bg-hanji-deep/60 px-4 py-3 text-muk-soft ${className}`}
      >
        <BellOff size={18} className="shrink-0 text-muk-soft" aria-hidden="true" />
        <span className="text-sm">{t('alert.unsupported')}</span>
      </div>
    );
  }

  const denied = permission === 'denied';
  const on = enabled && permission === 'granted';

  const label = denied
    ? t('alert.denied')
    : on
      ? t('alert.on')
      : t('alert.off');

  const Icon = denied ? BellOff : on ? BellRing : Bell;

  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={denied}
        aria-pressed={on}
        aria-label={label}
        className={[
          'group flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-all',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60',
          'shadow-[0_2px_14px_rgba(43,35,32,0.06)]',
          denied
            ? 'cursor-not-allowed border-line bg-hanji-deep/60 text-muk-soft opacity-80'
            : on
              ? 'border-gold bg-gold/15 text-muk hover:bg-gold/20'
              : 'border-line bg-white text-muk hover:bg-hanji-deep',
        ].join(' ')}
      >
        <span
          className={[
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors',
            denied
              ? 'bg-terracotta/10 text-terracotta'
              : on
                ? 'bg-gold text-white'
                : 'bg-jade/10 text-jade',
          ].join(' ')}
          aria-hidden="true"
        >
          <Icon size={18} className={on && !denied ? 'animate-pulse' : ''} />
        </span>

        <span className="flex min-w-0 flex-col">
          <span className="text-sm font-semibold leading-tight">{label}</span>
          <span className="text-xs leading-tight text-muk-soft">
            {denied
              ? t('alert.deniedSub')
              : on
                ? t('alert.onSub')
                : t('alert.offSub')}
          </span>
        </span>

        {/* on/off 스위치(시각적) */}
        {!denied && (
          <span
            className={[
              'relative ml-auto h-6 w-11 shrink-0 rounded-full transition-colors',
              on ? 'bg-gold' : 'bg-line',
            ].join(' ')}
            aria-hidden="true"
          >
            <span
              className={[
                'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all',
                on ? 'left-[22px]' : 'left-0.5',
              ].join(' ')}
            />
          </span>
        )}
      </button>
    </div>
  );
}

export default CongestionAlertToggle;
