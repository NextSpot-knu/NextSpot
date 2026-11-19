// 장소 사진 자리 — 아래에는 늘 장소 표지(경주 문양 + 유형 그림, PlacePhotoFallback)가 깔리고, 사진이 있으면 그 위에 얹어
// **다 받은 뒤에** 서서히 드러낸다(웹 PlacePhotoFallback + WaitingCardImage, G5a-15). 받는 동안 빈 상자·깨진 그림 대신 표지가 보이고,
// 후보가 다 깨지면 표지가 남는다.
// 어느 후보를 띄우는지·다 받았는지는 부모가 쥔다(usePhotoCursor) — 출처 줄이 '지금 보이는 사진' 과 같은 렌더에서 정해져야 한다.
import { Image } from 'expo-image';
import { useCallback, useState } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { PlacePhotoFallback } from '~/components/PlacePhotoFallback';
import { advancePhotoCursor, displayedPhotoUrl, type PhotoCursor } from '~/features/explore/port/photoCredit';
import { toHttpsImageUrl } from '~/lib/platform/images';
import type { PlaceVisual } from '@/lib/placeVisual';

/**
 * 사진 후보 커서 — 깨진 사진은 다음 후보로 건너뛰고, 보이는 URL 은 렌더 중에 바로 계산한다(웹 photoCursors·loadedPhotos).
 * `urls` 는 원문 주소 그대로(출처 판정이 글자 그대로 짝을 짓는다). https 로 그릴 수 없는 후보는 미리 뺀다.
 */
export function usePhotoCursor(urls: readonly string[]) {
  const drawable = urls.filter((u) => toHttpsImageUrl(u) !== null);
  const [cursor, setCursor] = useState<PhotoCursor | undefined>(undefined);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const url = displayedPhotoUrl(drawable, cursor);
  const loaded = url !== null && loadedUrl === url;
  const onLoaded = useCallback((u: string) => setLoadedUrl(u), []);
  const onError = useCallback(
    (failed: string) => setCursor((prev) => advancePhotoCursor(drawable, prev, failed) ?? prev),
    // drawable 은 렌더마다 새 배열이라 내용 키로 묶는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drawable.join('|')],
  );
  return { url, loaded, onLoaded, onError };
}

export interface PlaceTileProps {
  visual: PlaceVisual;
  /** 지금 띄울 사진(원문 주소) · 다 받았는가 — usePhotoCursor 의 값. */
  url: string | null;
  loaded: boolean;
  onLoaded: (url: string) => void;
  onError: (url: string) => void;
  /** 사진 접근성 라벨 — 꾸밈이면 비운다(웹 alt=name 은 카드 라벨이 읽으므로 앱은 숨긴다). */
  className?: string;
  style?: StyleProp<ViewStyle>;
}

export function PlaceTile({ visual, url, loaded, onLoaded, onError, className, style }: PlaceTileProps) {
  const shown = url ? toHttpsImageUrl(url) : null;
  return (
    <View
      className={`overflow-hidden ${className ?? ''}`}
      style={style}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <PlacePhotoFallback visual={visual} />
      {url && shown ? (
        <Image
          key={url}
          source={{ uri: shown }}
          contentFit="cover"
          transition={loaded ? 0 : 300}
          cachePolicy="memory-disk"
          recyclingKey={url}
          onLoad={() => onLoaded(url)}
          onError={() => onError(url)}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: loaded ? 1 : 0 }}
        />
      ) : null}
    </View>
  );
}
