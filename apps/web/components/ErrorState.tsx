'use client';

import { useT } from '@/lib/i18n/I18nProvider';

/**
 * 조회 실패를 **빈 상태와 구분해서** 보여주는 블록.
 *
 * 빈 목록과 실패를 같은 화면으로 처리하면 "주변에 갈 곳이 없어요" 같은 **사실이 아닌 문장**이
 * 나간다. 사용자는 앱이 아니라 자기 위치를 의심하게 되고, 다시 시도할 방법도 없다.
 * (app/course/page.tsx 에 있던 것을 공용으로 올렸다 — 추천 화면도 같은 문제가 있었다.)
 */
export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  const t = useT();
  return (
    <div className="bg-white rounded-2xl border border-terracotta/25 shadow-[0_2px_14px_rgba(43,35,32,0.06)] p-8 text-center space-y-3">
      <div className="text-3xl">⚠️</div>
      <p className="text-sm font-semibold text-muk">{message}</p>
      <button
        onClick={onRetry}
        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-gold text-white text-xs font-bold hover:bg-gold-deep transition-colors"
      >
        {t('common.retry')}
      </button>
    </div>
  );
}
