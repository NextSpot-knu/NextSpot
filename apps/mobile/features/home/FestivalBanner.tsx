// 축제 트리거 둘 — 'chip'(홈 필터·편의 시트 맨 아래 칩)과 'banner'(랜딩 '바로 시작' 아래 카드, G1-05). 누르면 같은 FestivalSheet.
// 웹 원본(0d145a1): apps/web/components/main/FestivalBanner.tsx 206-270.
//   chip   rounded-full border-line bg-white/80 px-3.5 py-2 text-[13px] medium muk-soft + 그림자, 개수 배지 18×18 10px bold
//          (진행 중이 있으면 bg-terracotta 흰 글자, 아니면 bg-gold/20 text-gold-deep)
//   banner w-full max-w-[24rem] gap-3 rounded-2xl border-terracotta/35 bg-white/90 py-2 pl-2 pr-3, 포스터 48×48 r12(없으면 🏮 bg-terracotta/10),
//          1줄 12 bold terracotta '🏮 지금 경주 축제 · 11.20까지(· 외 N건)', 2줄 이름 14 bold(ko 만), 3줄 출처 11, 오른쪽 ChevronRight 16
// 응답이 없거나 보일 것이 없으면 자리째 아무것도 그리지 않는다(빈 상태 문구 없음).
//
// 연결: 랜딩은 `<FestivalBanner variant="banner" />`(D1·F3 가 LandingHero 에 — 위치·동의가 없어 location·onFocus 를 주지 않는다),
// 홈 필터·편의 시트는 ToolsSheet 가 `<FestivalBanner variant="chip" location onFocus />` 를 안에 둔다.
import { Image } from 'expo-image';
import { ChevronRight } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { festivalBannerModel, festivalDateLabel, festivalTriggerVisible } from '@/lib/festivalBanner';
import { Icon, Pressable, Text } from '~/components/ui';
import { useI18n } from '~/lib/i18n/I18nProvider';
import { toHttpsImageUrl } from '~/lib/platform/images';

import { FestivalSheet } from './FestivalSheet';
import { loadFestivalEvents, type FestivalEvent } from './festival';

export interface FestivalBannerProps {
  variant?: 'chip' | 'banner';
  location?: { lat: number; lng: number } | null;
  onFocus?: (event: FestivalEvent) => void;
  className?: string;
}

/** 축제 자료를 한 번 받아 둔다 — null 이면 아직·실패(숨김). */
export function useFestivalEvents(): FestivalEvent[] | null {
  const [events, setEvents] = useState<FestivalEvent[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void loadFestivalEvents().then((list) => {
      if (!cancelled) setEvents(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return events;
}

export function FestivalBanner({ variant = 'chip', location, onFocus, className = '' }: FestivalBannerProps) {
  const { t, locale } = useI18n();
  const events = useFestivalEvents();
  const [open, setOpen] = useState(false);
  const [posterFailed, setPosterFailed] = useState(false);
  if (!events || !festivalTriggerVisible(variant, events)) return null;
  const model = variant === 'banner' ? festivalBannerModel(events) : null;
  const dateLabel = (iso: string) => festivalDateLabel(iso, locale);

  const sheet = <FestivalSheet open={open} onClose={() => setOpen(false)} events={events} location={location} onFocus={onFocus} />;

  if (variant === 'banner' && model) {
    const poster = !posterFailed ? toHttpsImageUrl(model.first.imageUrl) : null;
    return (
      <>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('festival.bannerAria', { title: model.first.title })}
          onPress={() => setOpen(true)}
          className={`w-full max-w-[384px] flex-row items-center gap-[12px] rounded-2xl border border-terracotta/35 py-[8px] pl-[8px] pr-[12px] ${className}`}
          style={{ backgroundColor: 'rgba(255, 255, 255, 0.9)', boxShadow: '0px 4px 18px rgba(43, 35, 32, 0.08)' }}
        >
          {poster ? (
            <Image source={{ uri: poster }} accessibilityIgnoresInvertColors onError={() => setPosterFailed(true)} style={{ width: 48, height: 48, borderRadius: 12 }} contentFit="cover" />
          ) : (
            <View className="h-[48px] w-[48px] items-center justify-center rounded-xl bg-terracotta/10" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <Text className="text-[20px] leading-none">🏮</Text>
            </View>
          )}
          <View className="min-w-0 flex-1">
            <View className="flex-row flex-wrap items-center" style={{ columnGap: 6 }}>
              <Text className="text-[12px] leading-[16.5px] text-terracotta" weight="bold">{`🏮 ${t('festival.bannerLabel')}`}</Text>
              <Text className="text-[12px] leading-[16.5px] text-muk-soft" weight="semibold">{`· ${t('festival.bannerUntil', { date: dateLabel(model.first.endDate) })}`}</Text>
              {model.moreCount > 0 ? (
                <Text className="text-[12px] leading-[16.5px] text-muk-soft" weight="semibold">{`· ${t('festival.bannerMore', { n: String(model.moreCount) })}`}</Text>
              ) : null}
            </View>
            {locale === 'ko' ? <Text className="mt-[2px] text-[14px] leading-[19px]" weight="bold" numberOfLines={1}>{model.first.title}</Text> : null}
            <Text className="text-[11px] leading-[15px] text-muk-soft">{t('festival.bannerCredit')}</Text>
          </View>
          <Icon icon={ChevronRight} size={16} color="muk-soft" />
        </Pressable>
        {sheet}
      </>
    );
  }

  const ongoing = events.some((ev) => ev.isOngoing);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('festival.chipAria', { n: String(events.length) })}
        onPress={() => setOpen(true)}
        hitSlop={{ top: 4, bottom: 4, left: 0, right: 0 }}
        className={`shrink-0 flex-row items-center gap-[8px] rounded-full border border-line px-[14px] py-[8px] ${className}`}
        style={{ backgroundColor: 'rgba(255, 255, 255, 0.8)', boxShadow: '0px 2px 14px rgba(43, 35, 32, 0.06)' }}
      >
        <Text className="text-[13px] leading-none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">🏮</Text>
        <Text className="text-[13px] text-muk-soft" weight="medium">{t('festival.chip')}</Text>
        <View className={`h-[18px] min-w-[18px] items-center justify-center rounded-full px-[4px] ${ongoing ? 'bg-terracotta' : 'bg-gold/20'}`}>
          <Text className={`text-[10px] leading-none ${ongoing ? 'text-white' : 'text-gold-deep'}`} weight="bold">{String(events.length)}</Text>
        </View>
      </Pressable>
      {sheet}
    </>
  );
}
