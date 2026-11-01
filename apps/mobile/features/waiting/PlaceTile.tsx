// 장소 사진 자리 — 아래에는 늘 장소 표지(유형 그림 + 장소마다 정해진 색)가 깔리고, 사진이 있으면 그 위에 얹어 **다 받은 뒤에**
// 서서히 드러낸다. 받는 동안 빈 상자·깨진 그림 대신 표지가 보이고, 후보가 다 깨지면 표지가 남는다(웹 PlacePhotoFallback +
// WaitingCardImage). 표지의 문양(기와·살문 등 SVG)은 앱 v1 에서 옮기지 않고 색 + 유형 이모지만 쓴다(PORTING.md).
// 사진 후보 순환·불러옴 상태는 이 컴포넌트가 쥔다 — 앱엔 출처 줄이 없어(photoUrlsOf) 부모와 나눌 것이 없다.
import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { Text } from '~/components/ui';
import { placeVisual } from '@/lib/placeVisual';

import { TYPE_EMOJI } from './boardData';

const TONE_CLASS = {
  slate: 'bg-tile-slate-bg',
  indigo: 'bg-tile-indigo-bg',
  stone: 'bg-tile-stone-bg',
} as const;

export interface PlaceTileProps {
  facilityId: string;
  type: string;
  urls: readonly string[];
  /** 사진 아래 표지의 이모지 크기. */
  glyphSize?: number;
  /** 사진을 사진 접근성 라벨로 읽을 이름(꾸밈이면 비운다). */
  className?: string;
  style?: StyleProp<ViewStyle>;
}

export function PlaceTile({ facilityId, type, urls, glyphSize = 30, className, style }: PlaceTileProps) {
  const visual = placeVisual(facilityId, type);
  const [index, setIndex] = useState(0);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const urlKey = urls.join('|');
  useEffect(() => {
    setIndex(0);
    setLoadedUrl(null);
  }, [urlKey]);
  const url = urls[index] ?? null;
  const shown = url !== null && loadedUrl === url;
  return (
    <View
      className={`overflow-hidden items-center justify-center ${TONE_CLASS[visual.tone]} ${className ?? ''}`}
      style={style}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Text style={{ fontSize: glyphSize, lineHeight: glyphSize + 6 }}>{TYPE_EMOJI[type] ?? '📍'}</Text>
      {url ? (
        <Image
          key={url}
          source={{ uri: url }}
          contentFit="cover"
          transition={shown ? 0 : 250}
          cachePolicy="memory-disk"
          recyclingKey={url}
          onLoad={() => setLoadedUrl(url)}
          onError={() => setIndex((i) => i + 1)}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: shown ? 1 : 0 }}
        />
      ) : null}
    </View>
  );
}
