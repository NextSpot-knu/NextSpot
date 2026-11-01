// 대안 카드 사진 — 웹 page.tsx 의 사진 블록 + PlacePhotoFallback + PhotoCreditLink.
// 아래에 늘 장소 표지가 깔려 있고 사진은 다 받은 뒤 그 위로 드러난다(카드 높이가 들쭉날쭉하지 않다).
// 깨진 사진은 다음 후보로 건너뛰고, 출처 줄은 지금 보이는 사진이 그 사진일 때(그리고 다 받은 뒤)만 드러난다.
// 표지의 경주 문양(SVG)은 옮기지 않았다 — 색 판 + 유형 그림만(PORTING.md).
import { Image } from 'expo-image';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { Text } from '~/components/ui';
import { Pressable } from '~/components/ui/Pressable';
import { openExternalUrl } from '~/lib/platform/links';
import { toHttpsImageUrl } from '~/lib/platform/images';
import { useT } from '~/lib/i18n/I18nProvider';
import { placeVisual, type PlaceGlyph, type PlaceTone } from '@/lib/placeVisual';

import {
  advancePhotoCursor,
  creditedPhotoUrls,
  creditForDisplayedPhoto,
  displayedPhotoUrl,
  photoCandidates,
  type PhotoCursor,
} from './port/photoCredit';

const TONE_BG: Record<PlaceTone, string> = {
  slate: 'bg-tile-slate-bg',
  indigo: 'bg-tile-indigo-bg',
  stone: 'bg-tile-stone-bg',
};
const GLYPH_EMOJI: Record<PlaceGlyph, string> = {
  restaurant: '🍴',
  cafe: '☕',
  attraction: '⛰️',
  culture: '🏛️',
  default: '📍',
};

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
  const t = useT();
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
      <View className={`h-[144px] w-full overflow-hidden rounded-xl border border-line ${TONE_BG[visual.tone]}`}>
        <View className="absolute inset-0 items-center justify-center" accessibilityElementsHidden importantForAccessibility="no">
          <View className="h-[44px] w-[44px] items-center justify-center rounded-full bg-hanji">
            <Text className="text-[20px]">{GLYPH_EMOJI[visual.glyph]}</Text>
          </View>
        </View>
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
      {credit && loaded ? (
        <Pressable
          accessibilityRole={credit.sourceUrl ? 'link' : 'text'}
          disabled={!credit.sourceUrl}
          onPress={() => void openExternalUrl(credit.sourceUrl)}
          hitSlop={{ top: 6, bottom: 6 }}
          noFeedback
          className="min-h-[24px] self-start justify-center py-[5px]"
        >
          <Text
            className={`text-[10px] leading-[14px] text-muk-soft ${credit.sourceUrl ? 'underline' : ''}`}
            numberOfLines={credit.kind === 'city' ? undefined : 1}
          >
            {credit.kind === 'city'
              ? t('common.cityPhotoCredit')
              : credit.license
                ? `${credit.label} · ${credit.license}`
                : credit.label}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
