// 대안 카드 안의 작은 위치 지도 — 웹 page.tsx 의 MiniMap(카카오 draggable:false · level 3 + 기본 마커 하나)을 NextSpotMap 으로.
// 키가 없거나 SDK 를 못 받으면 웹 목업 판처럼 📍 + 지역 문구 판(G4a-25).
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { Glow } from '~/components/ui/Glow';
import { Text } from '~/components/ui';
import { MAP_AVAILABLE, NextSpotMap, regionForKakaoLevel } from '~/features/map';
import { useT } from '~/lib/i18n/I18nProvider';

const MINI_LEVEL = 3;

export function MiniMapPreview({
  latitude,
  longitude,
  name,
}: {
  latitude: number;
  longitude: number;
  name: string;
}) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  const center = useMemo(() => ({ latitude, longitude }), [latitude, longitude]);
  const region = useMemo(() => regionForKakaoLevel(center, MINI_LEVEL), [center]);
  const markers = useMemo(
    () => [{ kind: 'default' as const, id: 'place', coordinate: center, title: name }],
    [center, name],
  );

  if (!MAP_AVAILABLE || failed) {
    // 웹 목업 판 — 한지 진 바탕, 노을 광원(-top-6 -right-6 80px blur-2xl), 📍 18px, 11/10px 두 줄(leading-tight).
    return (
      <View
        className="h-[96px] w-full items-center justify-center gap-[6px] overflow-hidden rounded-xl border border-line bg-hanji-deep p-[12px]"
        accessibilityLabel={name}
        accessibilityRole="image"
      >
        <Glow color="sunset-1" opacity={0.15} size={80} blur={40} position={{ top: -24, right: -24 }} />
        <Text className="text-[18px]" accessibilityElementsHidden importantForAccessibility="no">
          📍
        </Text>
        <View className="items-center">
          <Text className="text-center text-[11px] leading-[13.75px] text-muk" weight="semibold">
            {t('recommend.mapPreviewRegion')}
          </Text>
          <Text className="mt-[2px] text-center text-[10px] leading-[12.5px] text-muk-soft">
            {t('recommend.mapPreviewLabel')}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View
      className="h-[96px] w-full overflow-hidden rounded-xl border border-line bg-hanji-deep"
      accessibilityLabel={name}
      accessibilityRole="image"
    >
      <NextSpotMap
        interactive={false}
        muted={false}
        initialRegion={region}
        markers={markers}
        onUnavailable={() => setFailed(true)}
        style={{ flex: 1 }}
      />
    </View>
  );
}
