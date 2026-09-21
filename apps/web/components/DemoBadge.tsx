'use client';

// 데모 모드 공통 UI — 고정 배지 + '저장되지 않음' 토스트.
//
// 배지는 **항상 화면에 떠 있어야 한다**(스크롤해도 사라지지 않는다). 데모 콘솔은 실제 콘솔과
// 같은 컴포넌트로 그려지므로, 배지가 없으면 화면만 보고 실측과 구분할 방법이 없다.

import { Eye } from 'lucide-react';
import { toast } from 'sonner';
import { useT } from '@/lib/i18n/I18nProvider';

export function DemoBadge() {
  const t = useT();
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-3 pt-2.5">
      <div className="pointer-events-auto flex max-w-[calc(100vw-1.5rem)] items-center gap-2 rounded-full border border-gold/50 bg-muk/90 px-3.5 py-1.5 text-white shadow-lg backdrop-blur">
        <Eye size={14} className="flex-shrink-0 text-gold" aria-hidden="true" />
        <span className="text-[13px] font-bold leading-5">{t('demo.badge')}</span>
        <span className="hidden text-[13px] leading-5 text-white/70 sm:inline">{t('demo.badgeNote')}</span>
      </div>
    </div>
  );
}

/** 쓰기 동작 자리에 붙이는 안내 — 데모에서는 어떤 버튼도 서버를 부르지 않는다. */
export function useDemoToast() {
  const t = useT();
  return () => {
    toast(t('demo.noSave'));
  };
}
