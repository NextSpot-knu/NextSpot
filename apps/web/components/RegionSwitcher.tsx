'use client';

// 서비스 지역 스위처 — 내부 계정(developer)에게만, 그리고 서버가 내부 지역을 하나 이상 허락했을 때만 보인다.
// 관광객·게스트·관리자에게는 아무것도 그리지 않고 아무것도 묻지 않는다(목록 요청은 canSwitch 일 때만 — lib/regionContext).
// 활성 장소가 0곳인 지역은 고를 수 없게 흐리게 둔다. 모양은 LanguageSwitcher 와 같은 알약이다.
import { useEffect } from 'react';
import { FlaskConical, MapPinned } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { packDisplayName } from '@/lib/regionPacks';
import { useRegion } from '@/lib/regionContext';
import { PUBLIC_REGION_ID } from '@/lib/regionRuntime';

export function RegionSwitcher({ className = '' }: { className?: string }) {
  const { locale, t } = useI18n();
  const { canSwitch, availableRegions, regionId, setRegion, requestRegions, isPublic, ready, regionName } = useRegion();

  useEffect(() => {
    if (canSwitch) requestRegions();
  }, [canSwitch, requestRegions]);

  if (!canSwitch || availableRegions.length === 0) return null;
  // 내부 지역을 보는 중이면 스위처 자체가 그것을 표시한다(실험 아이콘 · 먹선 테두리) — /main 처럼 떠 있는 배지
  // (shell/RegionBadge)가 이 알약을 덮는 화면에서는 배지를 그리지 않기 때문이다.
  const internal = ready && !isPublic;

  return (
    <label
      data-testid="region-switcher"
      data-internal={internal ? 'true' : undefined}
      title={internal ? t('region.badgeInternal', { name: regionName }) : t('region.switchHint')}
      // min-w-0 · max-w-full — 좁은 줄(/main 위쪽 줄)에서는 제 칸보다 넓어지지 않고 이름을 자른다(select 가 줄어든다).
      className={`inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border bg-white px-3 text-sm text-muk shadow-[0_2px_14px_rgba(43,35,32,0.08)] ${internal ? 'border-muk' : 'border-line'} ${className}`}
    >
      {internal ? (
        <FlaskConical size={16} className="shrink-0 text-muk" aria-hidden data-testid="region-switcher-internal" />
      ) : (
        <MapPinned size={16} className="shrink-0 text-muk-soft" aria-hidden />
      )}
      <span className="sr-only">{t('region.switchTitle')}</span>
      {internal && <span className="sr-only">{t('region.badgeInternal', { name: regionName })}</span>}
      <select
        value={regionId}
        onChange={(e) => setRegion(e.target.value)}
        className="min-w-0 cursor-pointer self-stretch truncate bg-transparent py-1.5 pr-1 font-medium text-muk outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold/60"
      >
        <option value={PUBLIC_REGION_ID}>{t('region.name.gyeongju')}</option>
        {availableRegions.map((region) => (
          <option key={region.id} value={region.id} disabled={!region.selectable}>
            {region.selectable
              ? packDisplayName(region.pack, locale)
              : `${packDisplayName(region.pack, locale)} · ${t('region.emptyRegion')}`}
          </option>
        ))}
      </select>
    </label>
  );
}

export default RegionSwitcher;
