// 대안 카드 사진 — 웹 page.tsx 의 사진 블록 + PlacePhotoFallback + PhotoCreditLink.
// 아래에 늘 장소 표지(경주 문양 판)가 깔려 있고 사진은 다 받은 뒤 그 위로 드러난다(카드 높이가 들쭉날쭉하지 않다).
// 깨진 사진은 다음 후보로 건너뛰고, 출처 줄은 지금 보이는 사진이 그 사진일 때 자리를 잡되 다 받기 전에는 보이지 않는다(웹 invisible).
import { Image } from 'expo-image';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { PlacePhotoFallback } from '~/components/PlacePhotoFallback';
import { CreditLine } from '~/components/ui/CreditLine';
import { toHttpsImageUrl } from '~/lib/platform/images';
import { placeVisual } from '@/lib/placeVisual';

import {
  advancePhotoCursor,
  creditedPhotoUrls,
  creditForDisplayedPhoto,
  displayedPhotoUrl,
  photoCandidates,
  type PhotoCursor,
} from './port/photoCredit';

export function PhotoCover({
  facility,
}: {
  facility: {
    id: string;
    name: string;
    type: string;
    imageUrl?: string | null;
    galleryImages?: string[] | null;
    features?: Record<string, unknown> | null;
  };
}) {
  const features = facility.features ?? null;
  const visual = useMemo(() => placeVisual(facility.id, facility.type), [facility.id, facility.type]);
  const urls = useMemo(
    () => creditedPhotoUrls(photoCandidates(facility.imageUrl, facility.galleryImages), features),
    [facility.imageUrl, facility.galleryImages, features],
  );
  const [cursor, setCursor] = useState<PhotoCursor | undefined>(undefined);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const url = displayedPhotoUrl(urls, cursor);
  const shown = url ? toHttpsImageUrl(url) : null;
  const credit = creditForDisplayedPhoto(url, features);
  const loaded = url !== null && loadedUrl === url;

  return (
    <View>
      <View className="h-[144px] w-full overflow-hidden rounded-xl border border-line">
        <PlacePhotoFallback visual={visual} />
        {url && shown ? (
          <Image
            key={url}
            source={{ uri: shown }}
            accessibilityLabel={facility.name}
            contentFit="cover"
            transition={300}
            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: loaded ? 1 : 0 }}
            onLoad={() => setLoadedUrl(url)}
            onError={() => {
              const next = advancePhotoCursor(urls, cursor, url);
              if (next && next !== cursor) setCursor(next);
            }}
          />
        ) : null}
      </View>
      {credit ? (
        // 웹 `-mt-px -mb-[5px]` + 받기 전 invisible(자리는 차지).
        <View
          style={{ marginTop: -1, marginBottom: -5, opacity: loaded ? 1 : 0 }}
          pointerEvents={loaded ? 'auto' : 'none'}
          accessibilityElementsHidden={!loaded}
          importantForAccessibility={loaded ? 'auto' : 'no-hide-descendants'}
        >
          <CreditLine credit={credit} />
        </View>
      ) : null}
    </View>
  );
}
