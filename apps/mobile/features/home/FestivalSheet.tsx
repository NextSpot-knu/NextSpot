// 축제 목록 시트(G2-17 · G1-05 추출) — 웹 FestivalBanner 의 패널. 홈 필터·편의 시트 안 칩과 랜딩 배너가 같이 연다.
// 웹 원본(0d145a1): apps/web/components/main/FestivalBanner.tsx 280-451 — 막 black/30, 판 max-h 78vh max-w-lg rounded-t-3xl bg-hanji p-5,
//   머리 18 bold + 12 부제 + X, 카드 border-line bg-white/70 포스터 h-24 p-4 gap-2, 글자 10·11·14, 버튼 px 10 py 6 11 bold.
// `location`·`onFocus` 는 선택 — 랜딩은 동의 전이라 둘 다 없다(없으면 거리와 '지도에서 보기' 를 숨긴다, G1-05).
// 필터·편의 시트 위에 쌓아 열린다(stackBehavior push — 호출 쪽이 같은 ModalSheet 계층 안에서 부른다).
import { Image } from 'expo-image';
import { CalendarDays, ExternalLink, Map as MapIcon, MapPin, Phone } from 'lucide-react-native';
import { useState } from 'react';
import { Linking, View, useWindowDimensions } from 'react-native';

import { festivalDateLabel } from '@/lib/festivalBanner';
import { telHref } from '@/lib/phoneLink';
import { Icon, ModalSheet, Pressable, SheetScrollView, Text } from '~/components/ui';
import { MODAL_SHEET_CLOSE_BOX } from '~/components/ui';
import { useI18n } from '~/lib/i18n/I18nProvider';
import { openExternalUrl } from '~/lib/platform/links';
import { toHttpsImageUrl } from '~/lib/platform/images';

import { OVERVIEW_CLAMP_THRESHOLD, extractHomepageUrl, festivalDistanceLabel, type FestivalEvent } from './festival';

export interface FestivalSheetProps {
  open: boolean;
  onClose: () => void;
  events: readonly FestivalEvent[];
  /** 거리 표기용 현재 위치(선택). */
  location?: { lat: number; lng: number } | null;
  /** 지도에 표시(선택) — 주면 좌표 있는 축제에 '지도에서 보기' 버튼이 뜬다. */
  onFocus?: (event: FestivalEvent) => void;
}

const ACTION_HIT = { top: 8, bottom: 8, left: 0, right: 0 } as const;

function ActionPill({ icon, label, onPress, gold, accessibilityLabel }: {
  icon: typeof MapIcon;
  label: string;
  onPress: () => void;
  gold?: boolean;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      hitSlop={ACTION_HIT}
      className={`flex-row items-center gap-[4px] rounded-full border px-[10px] py-[6px] ${gold ? 'border-gold/40 bg-gold/15' : 'border-line bg-hanji-deep'}`}
    >
      <Icon icon={icon} size={11} color={gold ? 'gold-deep' : 'muk-soft'} />
      <Text className={`text-[11px] ${gold ? 'text-gold-deep' : 'text-muk-soft'}`} weight="bold">{label}</Text>
    </Pressable>
  );
}

export function FestivalSheet({ open, onClose, events, location = null, onFocus }: FestivalSheetProps) {
  const { t, locale } = useI18n();
  const { height } = useWindowDimensions();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const dateLabel = (iso: string) => festivalDateLabel(iso, locale);
  return (
    <ModalSheet
      open={open}
      onClose={onClose}
      handleLabel={t('common.close')}
      closeLabel={t('common.close')}
      background="hanji"
      bordered={false}
      showHandle={false}
      closeButton="plain"
      backdrop={{ color: '#000000', opacity: 0.3 }}
      maxWidth={512}
      maxHeight={Math.round(height * 0.78)}
      contentPadding={{ x: 20, top: 20, bottom: 20 }}
      stackBehavior="push"
    >
      <View className="mb-[16px]" style={{ paddingRight: MODAL_SHEET_CLOSE_BOX.plain + 12 }}>
        <Text className="text-[18px]" weight="bold" accessibilityRole="header">{`🏮 ${t('festival.title')}`}</Text>
        <Text className="text-[12px] text-muk-soft">{t('festival.subtitle')}</Text>
      </View>
      <SheetScrollView style={{ maxHeight: Math.round(height * 0.78) - 130 }} contentContainerStyle={{ gap: 12 }}>
        {events.map((ev) => {
          const place = ev.eventPlace ?? ev.address ?? null;
          const distance = festivalDistanceLabel(ev, location);
          const canFocus = !!onFocus && ev.latitude != null && ev.longitude != null;
          const homepage = extractHomepageUrl(ev.homepage);
          const aiSummary = locale !== 'ko' ? (ev.overviewI18n?.[locale] ?? null) : null;
          const overview = aiSummary ?? ev.overview ?? null;
          const isExpanded = expanded.has(ev.contentId);
          const poster = toHttpsImageUrl(ev.imageUrl);
          const tel = telHref(ev.tel);
          return (
            <View key={ev.contentId} className="overflow-hidden rounded-2xl border border-line" style={{ backgroundColor: 'rgba(255, 255, 255, 0.7)' }}>
              {poster ? <Image source={{ uri: poster }} accessibilityIgnoresInvertColors style={{ height: 96, width: '100%' }} contentFit="cover" /> : null}
              <View className="gap-[8px] p-[16px]">
                <View className="flex-row flex-wrap items-center gap-[8px]">
                  <View className={`rounded-full px-[8px] py-[2px] ${ev.isOngoing ? 'bg-terracotta/15' : 'bg-jade/15'}`}>
                    <Text className={`text-[10px] ${ev.isOngoing ? 'text-terracotta' : 'text-jade'}`} weight="bold">
                      {ev.isOngoing ? t('festival.ongoing') : t('festival.upcoming')}
                    </Text>
                  </View>
                  <View className="flex-row items-center gap-[4px]">
                    <Icon icon={CalendarDays} size={12} color="muk-soft" />
                    <Text className="text-[11px] text-muk-soft" weight="medium">{`${dateLabel(ev.startDate)} ~ ${dateLabel(ev.endDate)}`}</Text>
                  </View>
                  {distance ? (
                    <View className="flex-row items-center gap-[4px]">
                      <Icon icon={MapPin} size={12} color="gold-deep" />
                      <Text className="text-[11px] text-gold-deep" weight="bold">{distance}</Text>
                    </View>
                  ) : null}
                </View>
                <Text className="text-[14px] leading-[19px]" weight="bold">{ev.title}</Text>
                {place ? (
                  <View className="flex-row items-start gap-[4px]">
                    <View className="mt-[2px]"><Icon icon={MapPin} size={12} color="muk-soft" /></View>
                    <Text className="flex-1 text-[11px] leading-[15px] text-muk-soft">{place}</Text>
                  </View>
                ) : null}
                {ev.playtime ? <Text className="text-[11px] leading-[15px] text-muk-soft">{`🕐 ${ev.playtime}`}</Text> : null}
                {ev.usetimeFestival ? <Text className="text-[11px] leading-[15px] text-muk-soft">{`💰 ${ev.usetimeFestival}`}</Text> : null}
                {overview ? (
                  <View>
                    <View className="mb-[2px] flex-row items-center gap-[6px]">
                      <Text className="text-[10px] text-muk-soft" weight="bold">{t('festival.about')}</Text>
                      {aiSummary ? (
                        <View className="rounded-full border border-gold/30 bg-gold/10 px-[6px] py-px">
                          <Text className="text-[10px] text-gold-deep" weight="bold">{t('festival.aiSummary')}</Text>
                        </View>
                      ) : null}
                    </View>
                    <Text className="text-[11px] leading-[18px] text-muk-soft" numberOfLines={isExpanded ? undefined : 3}>{overview}</Text>
                    {overview.length > OVERVIEW_CLAMP_THRESHOLD ? (
                      <Pressable
                        accessibilityRole="button"
                        hitSlop={{ top: 14, bottom: 14, left: 8, right: 8 }}
                        className="mt-[4px] self-start"
                        onPress={() => setExpanded((prev) => {
                          const next = new Set(prev);
                          if (next.has(ev.contentId)) next.delete(ev.contentId); else next.add(ev.contentId);
                          return next;
                        })}
                      >
                        <Text className="text-[11px] text-gold-deep" weight="bold">{isExpanded ? t('festival.showLess') : t('festival.showMore')}</Text>
                      </Pressable>
                    ) : null}
                  </View>
                ) : null}
                <View className="flex-row flex-wrap items-center gap-[8px] pt-[4px]">
                  {canFocus ? (
                    <ActionPill
                      icon={MapIcon}
                      label={t('compare.showOnMap')}
                      accessibilityLabel={t('festival.showOnMapAria', { title: ev.title })}
                      gold
                      onPress={() => { onFocus?.(ev); onClose(); }}
                    />
                  ) : null}
                  {ev.latitude != null && ev.longitude != null ? (
                    <ActionPill
                      icon={ExternalLink}
                      label={t('festival.openMap')}
                      onPress={() => void openExternalUrl(`https://map.kakao.com/link/map/${encodeURIComponent(ev.title)},${ev.latitude},${ev.longitude}`)}
                    />
                  ) : null}
                  {homepage ? <ActionPill icon={ExternalLink} label={t('festival.homepage')} onPress={() => void openExternalUrl(homepage)} /> : null}
                  {tel ? <ActionPill icon={Phone} label={t('festival.call')} onPress={() => void Linking.openURL(tel).catch(() => undefined)} /> : null}
                </View>
              </View>
            </View>
          );
        })}
      </SheetScrollView>
    </ModalSheet>
  );
}
