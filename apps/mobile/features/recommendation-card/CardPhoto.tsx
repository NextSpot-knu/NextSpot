import { Image } from 'expo-image';
import { Camera, Coffee, EyeOff, Flag, Landmark, MapPin, Mountain, MoreHorizontal, Utensils } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { Alert, View } from 'react-native';

import { Icon, IconButton, Pressable, Text, toast } from '~/components/ui';
import { createPublicClient } from '~/lib/core/supabase';
import { toHttpsImageUrl } from '~/lib/platform/images';
import { openExternalUrl } from '~/lib/platform/links';
import { colors } from '~/lib/theme/tokens';

import type { CardModel } from './cardModel';
import { hidePhoto, reportPhoto } from './photoSafety';
import { useT } from '~/lib/i18n/I18nProvider';

const GLYPH = { restaurant: Utensils, cafe: Coffee, attraction: Mountain, culture: Landmark, default: MapPin } as const;

/**
 * 사진 띠(웹 카드의 2번) — 후보를 차례로 시도하고 전부 실패하면 장소 표지(톤 바탕 + 유형 그림)가 남는다.
 * 웹 PlacePhotoFallback 의 경주 문양 SVG 는 옮기지 않았다(톤 바탕 + 유형 그림만 — PORTING 참고).
 * 사장님이 올린 사진에는 '신고'와 '이 사진 숨기기'(M19)가 붙는다.
 */
export function CardPhoto({
  model,
  facilityName,
  onHidden,
  height = 160,
}: {
  model: CardModel;
  facilityName: string;
  /** 사진을 숨겼다 — 부모가 후보 목록을 다시 계산한다. */
  onHidden: (url: string) => void;
  height?: number;
}) {
  const t = useT();
  const [index, setIndex] = useState(0);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const key = model.photoUrls.join('|');
  useEffect(() => {
    setIndex(0);
    setMenuOpen(false);
  }, [key, model.id]);

  const raw = model.photoUrls[index];
  const url = toHttpsImageUrl(raw);
  const credit = raw ? model.creditFor(raw) : null;
  const showTourCredit = !!raw && loaded === url && model.photoIsTourApi(raw);
  const isMerchant = !!raw && raw === model.merchantPhoto;
  const tone = model.tileVisual.tone;
  const Glyph = GLYPH[model.tileVisual.glyph];

  const confirmReport = useCallback(() => {
    if (!raw) return;
    Alert.alert(t('app.cardSheet.photoReportTitle'), t('app.cardSheet.photoReportBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('app.cardSheet.photoReportSend'),
        style: 'destructive',
        onPress: () => {
          void reportPhoto(createPublicClient(), { facilityId: model.id, facilityName, photoUrl: raw }).then((ok) => {
            if (ok) toast.success(t('app.cardSheet.photoReported'));
            else toast.error(t('app.cardSheet.photoReportFailed'));
          });
          setMenuOpen(false);
        },
      },
    ]);
  }, [raw, model.id, facilityName, t]);

  const hide = useCallback(() => {
    if (!raw) return;
    hidePhoto(raw);
    setMenuOpen(false);
    onHidden(raw);
    toast(t('app.cardSheet.photoHidden'));
  }, [raw, onHidden, t]);

  return (
    <View>
      <View
        className="overflow-hidden rounded-2xl border border-line"
        style={{ height, backgroundColor: colors[`tile-${tone}-bg` as const] }}
      >
        {/* 장식 — 카드의 이름은 본문이 말한다 */}
        <View className="absolute inset-0 items-center justify-center" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <View className="h-[44px] w-[44px] items-center justify-center rounded-full bg-hanji/90">
            <Icon icon={Glyph} size="lg" color={colors[`tile-${tone}` as const]} />
          </View>
        </View>
        {url && (
          <Image
            key={url}
            source={{ uri: url }}
            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: loaded === url ? 1 : 0 }}
            contentFit="cover"
            transition={200}
            accessibilityLabel={facilityName}
            onLoad={() => setLoaded(url)}
            onError={() => setIndex((i) => i + 1)}
          />
        )}
        {showTourCredit && (
          <View className="absolute bottom-[6px] left-[6px] rounded-full bg-black/55 px-[8px] py-[2px]">
            <Text className="text-[11px] leading-[14px] text-white" weight="bold">{t('card.photoCredit')}</Text>
          </View>
        )}
        {!url && model.kakaoPlaceUrl && (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={t('card.photoOnKakao')}
            onPress={() => void openExternalUrl(model.kakaoPlaceUrl as string)}
            className="absolute bottom-[8px] right-[8px] min-h-[44px] flex-row items-center gap-[6px] rounded-full border border-line bg-white/95 px-[12px]"
          >
            <Icon icon={Camera} size="sm" />
            <Text className="text-[12px] leading-[16px]" weight="bold">{t('card.photoOnKakao')}</Text>
          </Pressable>
        )}
        {isMerchant && loaded === url && (
          <View className="absolute right-[4px] top-[4px]">
            <IconButton
              icon={MoreHorizontal}
              accessibilityLabel={t('app.cardSheet.photoMenu')}
              accessibilityState={{ expanded: menuOpen }}
              onPress={() => setMenuOpen((v) => !v)}
              className="rounded-full bg-white/90"
              size="md"
            />
          </View>
        )}
      </View>
      {isMerchant && menuOpen && (
        <View className="mt-[6px] flex-row gap-[8px]">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('app.cardSheet.photoReport')}
            onPress={confirmReport}
            className="min-h-[44px] flex-1 flex-row items-center justify-center gap-[6px] rounded-2xl border border-line bg-white px-[8px]"
          >
            <Icon icon={Flag} size="sm" color="terracotta" />
            <Text className="text-[13px] leading-[16px] text-terracotta" weight="bold">{t('app.cardSheet.photoReport')}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('app.cardSheet.photoHide')}
            onPress={hide}
            className="min-h-[44px] flex-1 flex-row items-center justify-center gap-[6px] rounded-2xl border border-line bg-white px-[8px]"
          >
            <Icon icon={EyeOff} size="sm" color="muk-soft" />
            <Text className="text-[13px] leading-[16px] text-muk-soft" weight="bold">{t('app.cardSheet.photoHide')}</Text>
          </Pressable>
        </View>
      )}
      {credit && (
        <Pressable
          accessibilityRole={credit.sourceUrl ? 'link' : 'text'}
          disabled={!credit.sourceUrl}
          onPress={() => void openExternalUrl(credit.sourceUrl)}
          hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
          className="min-h-[24px] justify-center py-[5px]"
        >
          <Text className="text-[10px] leading-[14px] text-muk-soft underline">
            {credit.kind === 'city' ? t('common.cityPhotoCredit') : credit.license ? `${credit.label} · ${credit.license}` : credit.label}
          </Text>
        </Pressable>
      )}
    </View>
  );
}
