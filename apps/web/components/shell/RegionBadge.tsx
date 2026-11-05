'use client';

// 내부 검증 지역 표시 — 공개 지역(경주)이 아닌 곳을 보는 동안만 화면 위쪽 가운데에 작게 뜬다.
// 화면을 가리지 않게 누를 수 없는 알약 하나다(pointer-events-none). 경주에서는 아무것도 그리지 않는다.
// 위쪽 줄에 지역 스위처가 있는 화면(/main)은 배지가 스위처를 덮으므로 그리지 않는다 — 그 화면에서는 스위처가
// 내부 지역을 표시한다(lib/regionBadgePlacement).
//
// 자리: 관광객 화면의 머리(/saved · /mypage 의 가운데 로고, /mypage 의 언어 알약 · 하위 화면의 제목)는 모두 위 여백 20px(p-5)
// 아래에서 시작한다. 배지는 그 여백 띠(위 2px ~ 16px) 안에 들어가는 낮은 알약(10px 글자 · 줄 간격 없음 · 높이 14px)이라
// 어떤 로케일에서도 로고 · 언어 알약 · 제목을 덮지 않는다(e2e region-switch 의 390px 겹침 검사가 잠근다).
import { usePathname } from 'next/navigation';
import { FlaskConical } from 'lucide-react';
import { useT } from '@/lib/i18n/I18nProvider';
import { showsFloatingRegionBadge } from '@/lib/regionBadgePlacement';
import { useRegion } from '@/lib/regionContext';

export default function RegionBadge() {
  const t = useT();
  const pathname = usePathname();
  const { isPublic, ready, regionName } = useRegion();
  if (isPublic || !ready || !showsFloatingRegionBadge(pathname)) return null;
  return (
    <div
      role="status"
      data-testid="region-badge"
      className="pointer-events-none fixed left-1/2 top-[calc(env(safe-area-inset-top)+2px)] z-[76] flex max-w-[calc(100vw-24px)] -translate-x-1/2"
    >
      <span className="inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-full bg-muk px-2 py-0.5 text-[10px] font-semibold leading-none text-hanji shadow-[0_2px_10px_rgba(43,35,32,0.18)]">
        <FlaskConical size={10} className="shrink-0" aria-hidden />
        <span className="truncate">{t('region.badgeInternal', { name: regionName })}</span>
      </span>
    </div>
  );
}
