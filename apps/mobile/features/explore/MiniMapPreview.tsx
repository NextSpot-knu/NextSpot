// 대안 카드 안의 작은 위치 지도 — 웹 page.tsx 의 MiniMap(카카오 draggable:false · level 3 + 마커 하나)을 NextSpotMap 으로.
import { useMemo } from 'react';
import { View } from 'react-native';

import { MAP_COLORS, NextSpotMap, regionForKakaoLevel } from '~/features/map';

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
  const center = useMemo(() => ({ latitude, longitude }), [latitude, longitude]);
  const region = useMemo(() => regionForKakaoLevel(center, MINI_LEVEL), [center]);
  const markers = useMemo(
    () => [{ kind: 'dot' as const, id: 'place', coordinate: center, color: MAP_COLORS.gold, size: 16, title: name }],
    [center, name],
  );
  return (
    <View
      className="h-[112px] w-full overflow-hidden rounded-xl border border-line bg-hanji-deep"
      accessibilityLabel={name}
      accessibilityRole="image"
    >
      <NextSpotMap interactive={false} muted={false} initialRegion={region} markers={markers} style={{ flex: 1 }} />
    </View>
  );
}
