// 홈 지도 위에 얹는 조각들 — 검색 결과 · 필터·편의 시트 · 같은 건물 목록 · 위치 안내 · 위치 배너.
// 웹 원본(0d145a1): apps/web/app/main/page.tsx 의 검색 결과 블록 · showMobileTools 시트 · 그룹 마커 팝업.
import { ChevronRight, Search, X } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';

import { formatDistance } from '@/lib/map/geo';
import { Button, Card, Icon, IconButton, ModalSheet, Pressable, SheetScrollView, Text } from '~/components/ui';
import { useT } from '~/lib/i18n/I18nProvider';
import { colors } from '~/lib/theme/tokens';

import {
  CUISINE_CHIPS,
  canSeeInstead,
  type Convenience,
  type CuisineChip,
  type HomeFacility,
} from './homeModel';
import type { PlaceSearchItem, PlaceSearchState, TourApiSearchItem } from './usePlaceSearch';

const ROW = 'min-h-[56px] flex-row items-center gap-[10px] border-t border-line px-[12px] py-[8px]';

// ── 검색 결과 ─────────────────────────────────────────────────────────

export interface SearchPanelProps {
  query: string;
  /** 우리 시설 중 일치한 곳(가까운 순, 이미 잘라 온다) · 거리(m). */
  local: { facility: HomeFacility; distM: number }[];
  external: PlaceSearchState;
  onPickLocal: (facility: HomeFacility) => void;
  onViewPlace: (item: PlaceSearchItem | TourApiSearchItem, kind: 'place' | 'tour') => void;
  onOpenKakaoPlace: (item: PlaceSearchItem) => void;
  onRouteTour: (item: TourApiSearchItem) => void;
  onSeeInsteadPlace: (item: PlaceSearchItem) => void;
}

function PanelTitle({ title, source }: { title: string; source?: string }) {
  return (
    <View className="px-[12px] py-[8px]">
      <View className="flex-row items-center gap-[6px]">
        <Icon icon={Search} size="xs" color="gold-deep" />
        <Text className="text-[12px]" weight="semibold">{title}</Text>
      </View>
      {source ? <Text className="mt-[2px] text-[11px] text-muk-soft">{source}</Text> : null}
    </View>
  );
}

function Loading() {
  return (
    <View accessibilityRole="progressbar" accessibilityState={{ busy: true }} className="min-h-[44px] items-start justify-center px-[12px]">
      <ActivityIndicator size="small" color={colors.gold} />
    </View>
  );
}

export function SearchPanel({ query, local, external, onPickLocal, onViewPlace, onOpenKakaoPlace, onRouteTour, onSeeInsteadPlace }: SearchPanelProps) {
  const t = useT();
  const q = query.trim();
  const { places, placesLoading, tour, tourLoading, tourAsked } = external;
  const none = local.length === 0 && !placesLoading && places.length === 0 && !tourLoading && tour.length === 0;
  return (
    <Card padded={false} className="overflow-hidden bg-white/95" style={{ maxHeight: 360 }}>
      <SheetFreeScroll>
        {none ? (
          <View className="min-h-[44px] justify-center px-[12px] py-[8px]">
            <Text className="text-[12px]">{tourAsked ? t('map.searchNoResultAnywhere', { q }) : t('map.searchNoResult', { q })}</Text>
          </View>
        ) : null}
        {local.length > 0 ? (
          <View>
            <PanelTitle title={t('home.searchLocalTitle')} />
            {local.map(({ facility, distM }) => (
              <Pressable
                key={facility.id}
                accessibilityRole="button"
                accessibilityLabel={t('calm.showOnMapAria', { name: facility.name })}
                onPress={() => onPickLocal(facility)}
                className={ROW}
              >
                <View className="min-w-0 flex-1">
                  <Text className="text-[14px]" weight="medium" numberOfLines={1}>{facility.name}</Text>
                  {facility.address ? <Text className="text-[11px] text-muk-soft" numberOfLines={1}>{facility.address}</Text> : null}
                </View>
                <Text className="text-[11px] text-muk-soft">{formatDistance(distM)}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {placesLoading || places.length > 0 ? (
          <View>
            <PanelTitle title={t('map.placeSearchTitle')} source={t('map.placeSearchSource')} />
            {placesLoading ? <Loading /> : places.map((item) => (
              <View key={item.placeId} className="gap-[4px] border-t border-line px-[12px] py-[8px]">
                <Text className="text-[14px]" weight="medium" numberOfLines={1}>{item.name}</Text>
                {item.address ? <Text className="text-[11px] text-muk-soft" numberOfLines={1}>{item.address}</Text> : null}
                <Text className="text-[11px] text-muk-soft" numberOfLines={1}>{item.categoryName || t('map.placeSearchResult')}</Text>
                <View className="flex-row flex-wrap gap-[8px]">
                  <SmallAction label={t('map.placeSearchView')} onPress={() => onViewPlace(item, 'place')} />
                  {item.placeUrl ? <SmallAction label={t('map.searchKakaoPlace')} onPress={() => onOpenKakaoPlace(item)} /> : null}
                  {item.type && canSeeInstead(item.type) ? (
                    <SmallAction
                      label={t('waiting.seeInstead')}
                      accessibilityLabel={t('card.seeInsteadAria', { name: item.name })}
                      trailing
                      onPress={() => onSeeInsteadPlace(item)}
                    />
                  ) : null}
                </View>
              </View>
            ))}
          </View>
        ) : null}
        {tourLoading || tour.length > 0 ? (
          <View>
            <PanelTitle title={t('map.tourApiTitle')} source={t('map.tourApiSource')} />
            {tourLoading ? <Loading /> : tour.map((item) => {
              const hasPoint = typeof item.mapy === 'number' && typeof item.mapx === 'number';
              return (
                <View key={item.contentid} className="gap-[4px] border-t border-line px-[12px] py-[8px]">
                  <Text className="text-[14px]" weight="medium" numberOfLines={1}>{item.title}</Text>
                  {item.addr1 ? <Text className="text-[11px] text-muk-soft" numberOfLines={1}>{item.addr1}</Text> : null}
                  {hasPoint ? (
                    <View className="flex-row flex-wrap gap-[8px]">
                      <SmallAction label={t('map.placeSearchView')} onPress={() => onViewPlace(item, 'tour')} />
                      <SmallAction label={t('map.searchKakaoRoute')} onPress={() => onRouteTour(item)} />
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
        ) : null}
      </SheetFreeScroll>
    </Card>
  );
}

function SheetFreeScroll({ children }: { children: ReactNode }) {
  return <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled>{children}</ScrollView>;
}

function SmallAction({ label, onPress, trailing, accessibilityLabel }: { label: string; onPress: () => void; trailing?: boolean; accessibilityLabel?: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      className="min-h-[44px] flex-row items-center gap-[2px] rounded-full border border-line bg-hanji-deep px-[12px]"
    >
      <Text className="text-[12px] text-muk" weight="bold">{label}</Text>
      {trailing ? <Icon icon={ChevronRight} size="sm" color="muk-soft" /> : null}
    </Pressable>
  );
}

// ── 필터·편의 시트 ────────────────────────────────────────────────────

export interface FilterSheetProps {
  open: boolean;
  onClose: () => void;
  convenience: Convenience;
  onToggle: (key: keyof Convenience) => void;
  /** 확인된 곳이 한 칩에도 없으면 숨기고, 켜져 있는 동안은 끌 수 있게 남긴다(웹과 같다). */
  showAccessible: boolean;
  showStroller: boolean;
  showPet: boolean;
  showCuisine: boolean;
  cuisineId: string | null;
  onSelectCuisine: (chip: CuisineChip) => void;
}

function ToggleTile({ emoji, label, on, onPress }: { emoji: string; label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      accessibilityLabel={label}
      onPress={onPress}
      className={`min-h-[48px] w-[48%] flex-row items-center justify-center gap-[6px] rounded-xl border px-[12px] py-[10px] ${on ? 'border-jade bg-jade-chip' : 'border-line bg-white'}`}
    >
      <Text className="text-[14px]" accessibilityElementsHidden>{emoji}</Text>
      <Text className="text-[14px]" weight="semibold">{label}</Text>
    </Pressable>
  );
}

export function FilterSheet(props: FilterSheetProps) {
  const t = useT();
  const { convenience: c } = props;
  return (
    <ModalSheet open={props.open} onClose={props.onClose} handleLabel={t('common.close')} closeLabel={t('common.close')}>
      <View className="mb-[12px] flex-row items-start justify-between gap-[8px]">
        <View className="flex-1">
          <Text className="text-[16px]" weight="bold" accessibilityRole="header">{t('map.mobileToolsTitle')}</Text>
          <Text className="text-[12px] text-muk-soft">{t('map.mobileToolsDesc')}</Text>
        </View>
        <IconButton icon={X} accessibilityLabel={t('common.close')} onPress={props.onClose} className="border border-line bg-white" />
      </View>
      <View className="flex-row flex-wrap gap-[8px]">
        {props.showAccessible || c.accessible ? <ToggleTile emoji="♿" label={t('map.barrierFree')} on={c.accessible} onPress={() => props.onToggle('accessible')} /> : null}
        {props.showStroller || c.stroller ? <ToggleTile emoji="👶" label={t('map.stroller')} on={c.stroller} onPress={() => props.onToggle('stroller')} /> : null}
        <ToggleTile emoji="🅿" label={t('map.filterParking')} on={c.parking} onPress={() => props.onToggle('parking')} />
        {props.showPet || c.pet ? <ToggleTile emoji="🐾" label={t('map.filterPet')} on={c.pet} onPress={() => props.onToggle('pet')} /> : null}
      </View>
      {props.showCuisine ? (
        <View className="mt-[16px]">
          <Text className="mb-[8px] text-[12px] text-muk-soft" weight="bold">{t('map.foodFilters')}</Text>
          <View className="flex-row flex-wrap gap-[8px]">
            {CUISINE_CHIPS.map((chip) => {
              const on = props.cuisineId === chip.id;
              return (
                <Pressable
                  key={chip.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  onPress={() => props.onSelectCuisine(chip)}
                  className={`min-h-[44px] flex-row items-center gap-[4px] rounded-full border px-[14px] ${on ? 'border-jade bg-jade-chip' : 'border-line bg-white'}`}
                >
                  <Text className="text-[13px]" accessibilityElementsHidden>{chip.emoji}</Text>
                  <Text className="text-[13px]" weight="semibold">{t(`cuisine.${chip.id}`)}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}
    </ModalSheet>
  );
}

// ── 같은 건물 묶음 핀 목록 ────────────────────────────────────────────

export function GroupSheet({ title, members, onClose, onPick }: {
  title: string;
  /** null 이면 닫힌 시트. */
  members: HomeFacility[] | null;
  onClose: () => void;
  onPick: (facility: HomeFacility) => void;
}) {
  const t = useT();
  return (
    <ModalSheet open={members !== null} onClose={onClose} handleLabel={t('common.close')} closeLabel={t('common.close')}>
      <Text className="mb-[8px] text-[12px] text-gold-deep" weight="bold" accessibilityRole="header">{title}</Text>
      <SheetScrollView style={{ maxHeight: 360 }}>
        {(members ?? []).map((m) => (
          <Pressable
            key={m.id}
            accessibilityRole="button"
            onPress={() => onPick(m)}
            className="min-h-[48px] justify-center rounded-xl px-[12px] py-[10px]"
          >
            <Text className="text-[14px]" weight="semibold">{m.name}</Text>
          </Pressable>
        ))}
      </SheetScrollView>
    </ModalSheet>
  );
}

// ── 위치 ──────────────────────────────────────────────────────────────

/** 시스템 창 앞 안내 — HIG: 버튼은 '계속' 하나, 빠져나가는 버튼을 두지 않는다(계획 §6.2 ②). */
export function LocationPrimer({ onContinue }: { onContinue: () => void }) {
  const t = useT();
  return (
    <View className="absolute inset-0 items-center justify-center bg-muk/35 px-[24px]" accessibilityViewIsModal>
      <Card elevation="surface" className="w-full max-w-[360px] items-center gap-[12px]">
        <Text className="text-[34px]" accessibilityElementsHidden>📍</Text>
        <Text className="text-center text-[18px]" weight="bold" accessibilityRole="header">{t('home.locationPrimer.title')}</Text>
        <Text className="text-center text-[14px] leading-[21px] text-muk-soft">{t('home.locationPrimer.body')}</Text>
        <Button block variant="primary" label={t('home.locationPrimer.continue')} onPress={onContinue} />
      </Card>
    </View>
  );
}

/** 거부 · 동의 없음 · 대략적 위치 배너 — 닫을 수 있고, 누르면 설정 앱(동의 없음이면 동의 화면)으로. */
export function LocationBanner({ kind, onOpenSettings, onDismiss }: { kind: 'denied' | 'coarse'; onOpenSettings: () => void; onDismiss: () => void }) {
  const t = useT();
  const message = kind === 'denied' ? t('home.locationBanner.enable') : t('home.locationBanner.coarse');
  return (
    <Card padded={false} className="flex-row items-center gap-[4px] pl-[14px] pr-[4px]" elevation="surface">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={message}
        onPress={onOpenSettings}
        className="min-h-[48px] flex-1 flex-row items-center gap-[8px]"
      >
        <Text className="text-[13px]" accessibilityElementsHidden>📍</Text>
        <Text className="flex-1 text-[13px]" weight="semibold">{message}</Text>
        <Icon icon={ChevronRight} size="sm" color="muk-soft" />
      </Pressable>
      <IconButton icon={X} accessibilityLabel={t('common.close')} onPress={onDismiss} />
    </Card>
  );
}
