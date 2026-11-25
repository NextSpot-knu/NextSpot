'use client';

// 관제 데모의 표시 — 머리글 제목 옆 '예시 화면' 칩 하나(대시보드 데모 · 사장님 콘솔 데모와 같은 모양).
// 데모가 아니면 아무것도 그리지 않는다. 화면마다 머리글에 하나만 둔다(e2e 가 칩이 정확히 하나인지 본다).

import { useAdminDemo } from '@/lib/adminDemo';
import { useT } from '@/lib/i18n/I18nProvider';

export function AdminDemoChip() {
  const demo = useAdminDemo();
  const t = useT();
  if (!demo) return null;
  return (
    <span className="flex-shrink-0 rounded-full border border-muk/20 bg-muk px-2.5 py-0.5 text-[12px] font-bold text-hanji">
      {t('demo.sampleChip')}
    </span>
  );
}
