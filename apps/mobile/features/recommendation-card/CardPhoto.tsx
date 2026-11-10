import { Image } from 'expo-image';
import { Camera, EyeOff, Flag, MoreHorizontal } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { Alert, View } from 'react-native';

import { PlacePhotoFallback } from '~/components/PlacePhotoFallback';
import { CreditLine } from '~/components/ui/CreditLine';
import { Icon, IconButton, Pressable, Text, toast } from '~/components/ui';
import { createPublicClient } from '~/lib/core/supabase';
import { toHttpsImageUrl } from '~/lib/platform/images';
import { openExternalUrl } from '~/lib/platform/links';

import type { CardModel } from './cardModel';
import { hidePhoto, reportPhoto } from './photoSafety';
import { useT } from '~/lib/i18n/I18nProvider';

/** 카카오맵 사진 링크 그림자 — 웹 shadow-[0_2px_10px_rgba(43,35,32,0.12)](토큰에 아직 없다). */
const KAKAO_LINK_SHADOW = '0px 2px 10px rgba(43, 35, 32, 0.12)';

/**
 * 사진 띠(웹 RecommendationCard 의 2번 · .rec-photo 112) — 아래층은 장소 표지(PlacePhotoFallback, 경주 문양 판),
 * 그 위에 사진 후보를 차례로 시도해 받으면 300ms 로 드러낸다. 전부 실패하면 표지가 남는다.
 * TourAPI 사진이면 'ⓒ한국관광공사' 표를 사진 위에, Wikimedia·경주시 사진이면 출처 줄(CreditLine)을 사진 아래에.
 * 출처 판정은 카드 모델(creditFor · photoIsTourApi — features/explore/port/photoCredit 한 곳)이 한다.
 * 사장님이 올린 사진에는 '신고'와 '이 사진 숨기기'(M19)가 붙는다 — 웹에 없는 앱 전용(Play 사용자 콘텐츠 정책, G3-35).
 */
export function CardPhoto({
  model,
  facilityName,
  onHidden,
  height = 112,
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
  const isLoaded = !!url && loaded === url;
  const showTourCredit = !!raw && isLoaded && model.photoIsTourApi(raw);
  const isMerchant = !!raw && raw === model.merchantPhoto;

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
      {/* 웹 rec-photo relative overflow-hidden rounded-2xl border border-line */}
      <View className="overflow-hidden rounded-2xl border border-line" style={{ height }}>
        {/* 장식 — 카드의 이름은 본문이 말한다(표지는 읽기 화면에서 숨는다) */}
        <PlacePhotoFallback visual={model.tileVisual} />
        {url && (
          // 웹 transition-opacity duration-300 — expo-image 는 받기 전에는 아무것도 그리지 않고, 받으면 300ms 로 드러난다.
          <Image
            key={url}
            source={{ uri: url }}
            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
            contentFit="cover"
            transition={300}
            accessibilityLabel={facilityName}
            onLoad={() => setLoaded(url)}
            onError={() => setIndex((i) => i + 1)}
          />
        )}
        {showTourCredit && (
          // 웹 absolute bottom-1.5 left-1.5 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-bold text-white
          <View className="absolute bottom-[6px] left-[6px] rounded-full bg-black/55 px-[8px] py-[2px]">
            <Text className="text-[11px] leading-[14px] text-white" weight="bold">{t('card.photoCredit')}</Text>
          </View>
        )}
        {!url && model.kakaoPlaceUrl && (
          // 웹 absolute bottom-2 right-2 h-11 gap-1.5 rounded-full border-line bg-white/95 px-3 text-[12px] font-bold text-muk + 그림자
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={t('card.photoOnKakao')}
            onPress={() => void openExternalUrl(model.kakaoPlaceUrl as string)}
            className="absolute bottom-[8px] right-[8px] h-[44px] flex-row items-center gap-[6px] rounded-full border border-line bg-white/95 px-[12px]"
            style={{ boxShadow: KAKAO_LINK_SHADOW }}
          >
            <Icon icon={Camera} size={14} color="muk" />
            <Text className="text-[12px] leading-[16px] text-muk" weight="bold">{t('card.photoOnKakao')}</Text>
          </Pressable>
        )}
        {isMerchant && isLoaded && (
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
        // 웹 PhotoCreditLink -mt-px -mb-[5px] — 누르는 자리 24 중 글자 줄만 사진 4px 아래에 보이게. 사진을 받기 전에는
        // 자리만 두고 숨긴다(웹 invisible — 보이지도 눌리지도 읽히지도 않는다).
        <View
          className="-mb-[5px] -mt-[1px]"
          style={isLoaded ? undefined : { opacity: 0 }}
          pointerEvents={isLoaded ? 'auto' : 'none'}
          accessibilityElementsHidden={!isLoaded}
          importantForAccessibility={isLoaded ? 'auto' : 'no-hide-descendants'}
        >
          <CreditLine credit={credit} />
        </View>
      )}
    </View>
  );
}
