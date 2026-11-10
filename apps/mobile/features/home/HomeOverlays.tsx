// 홈 지도 위에 얹는 조각들 — 검색 결과(카카오·관광공사·결과 없음 알약) · 필터·편의 시트 · 위치 사전 안내(네이티브).
// 웹 원본(0d145a1): apps/web/app/main/page.tsx 의 검색 결과 블록 · showMobileTools 시트.
// 같은 건물 묶음 목록은 지도 위 말풍선(NextSpotMap popover, G2-31)으로 바꿨고, 위치 배너·'내 위치' 버튼은 웹처럼 없앴다(D3 ① — 실패 알약만).
import { ChevronRight, Search } from 'lucide-react-native';
import { Image } from 'expo-image';
import { useState, type ReactNode } from 'react';
import { Platform, ScrollView, View, type ViewStyle } from 'react-native';

import { Button, Card, Icon, MODAL_SHEET_CLOSE_BOX, ModalSheet, Pressable, RingSpinner, Text } from '~/components/ui';
import { toHttpsImageUrl } from '~/lib/platform/images';
import { useT } from '~/lib/i18n/I18nProvider';
import { colors } from '~/lib/theme/tokens';

import {
  CUISINE_CHIPS,
  canSeeInstead,
  type Convenience,
  type CuisineChip,
} from './homeModel';
import { FestivalBanner } from './FestivalBanner';
import type { FestivalEvent } from './festival';
import { RestroomChip } from './ToolChips';
import type { PlaceSearchItem, TourApiSearchItem } from './usePlaceSearch';

const GOLD_RING = '0px 0px 0px 1px #faf5ec, 0px 0px 0px 3px rgba(193, 154, 62, 0.7)';
const JADE = 'rgb(62, 124, 106)';
const PANEL_SHADOW = '0px 2px 14px rgba(43, 35, 32, 0.06)';
/** 웹 검색 결과 판 backdrop-blur(8px) — 웹 빌드만(네이티브는 95% 흰색 그대로, D14). */
const WEB_BLUR = Platform.OS === 'web' ? ({ backdropFilter: 'blur(8px)' } as unknown as ViewStyle) : null;

function ToolTile({ emoji, label, on, onPress }: { emoji: string; label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      accessibilityLabel={label}
      onPress={onPress}
      className="flex-1 items-center justify-center rounded-xl border px-[12px] py-[12px]"
      style={{ borderColor: on ? JADE : 'rgba(62, 124, 106, 0.3)', backgroundColor: on ? 'rgba(62, 124, 106, 0.15)' : '#ffffff' }}
    >
      <Text className="text-sm" weight="semibold">{`${emoji} ${label}`}</Text>
    </Pressable>
  );
}

export interface ToolsSheetProps {
  open: boolean;
  onClose: () => void;
  convenience: Convenience;
  onToggle: (key: 'accessible' | 'stroller' | 'parking') => void;
  showAccessible: boolean;
  showStroller: boolean;
  showCuisine: boolean;
  cuisineId: string | null;
  /** 첫 설정에서 고른 음식 칩 — 선택되지 않았으면 금 링으로 알려 준다. */
  cuisineSetupId?: string | null;
  onSelectCuisine: (chip: CuisineChip) => void;
  /** 시트 맨 아래 축제·화장실 칩용. 위치가 없으면 화장실은 그리지 않고 축제는 거리 없이. */
  location?: { lat: number; lng: number } | null;
  onFocusFestival?: (event: FestivalEvent) => void;
  /** 서비스 지역에 축제가 없으면 false(웹 regionFeatures.festival). 기본 true. */
  showFestival?: boolean;
}

/** 필터·편의 시트(G2-27) — 웹 page.tsx 4571-4595: 한지 바탕 · 손잡이 없음 · X(흰 원) · 막 muk 35% · 2열 칸 · 음식 칩 한 줄 · 축제·화장실. */
export function ToolsSheet(props: ToolsSheetProps) {
  const t = useT();
  const { convenience: c } = props;
  const tiles: { key: string; emoji: string; label: string; on: boolean; press: () => void }[] = [];
  if (props.showAccessible || c.accessible) tiles.push({ key: 'accessible', emoji: '♿', label: t('map.barrierFree'), on: c.accessible, press: () => props.onToggle('accessible') });
  if (props.showStroller || c.stroller) tiles.push({ key: 'stroller', emoji: '👶', label: t('map.stroller'), on: c.stroller, press: () => props.onToggle('stroller') });
  tiles.push({ key: 'parking', emoji: '🅿', label: t('map.filterParking'), on: c.parking, press: () => props.onToggle('parking') });
  const rows: (typeof tiles)[] = [];
  for (let i = 0; i < tiles.length; i += 2) rows.push(tiles.slice(i, i + 2));
  return (
    <ModalSheet
      open={props.open}
      onClose={props.onClose}
      handleLabel={t('common.close')}
      closeLabel={t('common.close')}
      background="hanji"
      bordered={false}
      showHandle={false}
      closeButton="bordered"
      backdrop={{ color: '#2b2320', opacity: 0.35 }}
      contentPadding={{ x: 16, top: 12, bottom: 20 }}
    >
      <View className="mb-[16px]" style={{ paddingRight: MODAL_SHEET_CLOSE_BOX.bordered + 12 }}>
        <Text className="text-[16px]" weight="bold" accessibilityRole="header">{t('map.mobileToolsTitle')}</Text>
        <Text className="text-[12px] text-muk-soft">{t('map.mobileToolsDesc')}</Text>
      </View>
      <View className="gap-[8px]">
        {rows.map((row) => (
          <View key={row[0].key} className="flex-row gap-[8px]">
            {row.map((tile) => <ToolTile key={tile.key} emoji={tile.emoji} label={tile.label} on={tile.on} onPress={tile.press} />)}
            {row.length === 1 ? <View className="flex-1" /> : null}
          </View>
        ))}
      </View>
      {props.showCuisine ? (
        <View className="mt-[16px]">
          <Text className="mb-[8px] text-[12px] text-muk-soft" weight="bold">{t('map.foodFilters')}</Text>
          <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, padding: 4, margin: -4 }}>
            {CUISINE_CHIPS.map((chip) => {
              const on = props.cuisineId === chip.id;
              const ring = !on && props.cuisineSetupId === chip.id;
              return (
                <Pressable
                  key={chip.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  hitSlop={{ top: 8, bottom: 8, left: 2, right: 2 }}
                  onPress={() => props.onSelectCuisine(chip)}
                  className={`shrink-0 flex-row items-center gap-[4px] rounded-full border px-[12px] py-[6px] ${on ? 'border-gold bg-gold/15' : 'border-line bg-white'}`}
                  style={ring ? { boxShadow: GOLD_RING } : undefined}
                >
                  <Text className="text-xs" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{chip.emoji}</Text>
                  <Text className={`text-xs ${on ? 'text-gold-deep' : 'text-muk'}`} weight="semibold">{t(`cuisine.${chip.id}`)}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}
      <View className="mt-[16px] flex-row flex-wrap gap-[8px]">
        {props.showFestival === false ? null : <FestivalBanner variant="chip" location={props.location} onFocus={props.onFocusFestival} />}
        {props.location ? <RestroomChip location={props.location} /> : null}
      </View>
    </ModalSheet>
  );
}

/** 검색 결과 없음(G2-22) — 웹처럼 내용 폭 알약(흰 90% · border-line · px 12 py 4 · 12px · 카드 그림자). 칩 줄은 그대로 남는다. */
export function SearchNoResultPill({ message }: { message: string }) {
  return (
    <View className="self-start" style={{ marginLeft: 8, marginTop: -4 }}>
      <View className="rounded-full border border-line px-[12px] py-[4px]" style={{ backgroundColor: 'rgba(255, 255, 255, 0.9)', boxShadow: PANEL_SHADOW }}>
        <Text className="text-xs">{message}</Text>
      </View>
    </View>
  );
}

function ResultsPanel({ title, source, tone, loading, children }: { title: string; source: string; tone: 'gold' | 'jade'; loading: boolean; children: ReactNode }) {
  return (
    <View
      className={`overflow-hidden rounded-2xl border ${tone === 'jade' ? 'border-jade/40' : 'border-line'}`}
      style={[{ backgroundColor: 'rgba(255, 255, 255, 0.95)', boxShadow: PANEL_SHADOW }, WEB_BLUR]}
    >
      <View className="border-b border-line/70 px-[12px] py-[8px]">
        <View className="flex-row items-center gap-[6px]">
          <Icon icon={Search} size={12} color={tone} />
          <Text className="text-xs" weight="semibold">{title}</Text>
        </View>
        <Text className="mt-[2px] text-[10px] leading-[13.75px] text-muk-soft">{source}</Text>
      </View>
      {loading ? (
        <View accessibilityRole="progressbar" accessibilityState={{ busy: true }} className="flex-row items-center px-[12px] py-[12px]">
          <RingSpinner size={12} borderWidth={2} trackColor={tone === 'jade' ? 'rgba(62, 124, 106, 0.4)' : undefined} headColor={tone} />
        </View>
      ) : (
        <ScrollView style={{ maxHeight: 256 }} keyboardShouldPersistTaps="handled" nestedScrollEnabled>{children}</ScrollView>
      )}
    </View>
  );
}

/** 카카오 장소 결과(G2-20) — 왼쪽(이름·주소·분류 알약·jade '대신 갈 곳 보기') / 오른쪽 세로(금 외곽 '지도에서 보기' + 글자 링크 '카카오맵'). */
export function PlaceSearchResults({ items, loading, onView, onOpenKakao, onSeeInstead }: {
  items: readonly PlaceSearchItem[];
  loading: boolean;
  onView: (item: PlaceSearchItem) => void;
  onOpenKakao: (item: PlaceSearchItem) => void;
  onSeeInstead: (item: PlaceSearchItem) => void;
}) {
  const t = useT();
  if (!loading && items.length === 0) return null;
  return (
    <ResultsPanel title={t('map.placeSearchTitle')} source={t('map.placeSearchSource')} tone="gold" loading={loading}>
      {items.map((item, i) => (
        <View key={item.placeId} className={`flex-row items-start gap-[8px] px-[12px] py-[10px] ${i > 0 ? 'border-t border-line/60' : ''}`}>
          <View className="min-w-0 flex-1">
            <Text className="text-sm" weight="medium" numberOfLines={1}>{item.name}</Text>
            {item.address ? <Text className="text-[11px] text-muk-soft" numberOfLines={1}>{item.address}</Text> : null}
            <View className="mt-[4px] self-start rounded-full px-[8px] py-[2px]" style={{ backgroundColor: 'rgba(230, 220, 198, 0.6)' }}>
              <Text className="text-[10px] text-muk-soft" weight="medium">{item.categoryName || t('map.placeSearchResult')}</Text>
            </View>
            {item.type && canSeeInstead(item.type) ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('card.seeInsteadAria', { name: item.name })}
                onPress={() => onSeeInstead(item)}
                className="mt-[8px] min-h-[44px] flex-row items-center gap-[4px] self-start rounded-full border px-[14px]"
                style={{ borderColor: 'rgba(62, 124, 106, 0.5)', backgroundColor: 'rgba(62, 124, 106, 0.05)' }}
              >
                <Text className="shrink text-[13px] text-jade" weight="semibold" numberOfLines={1}>{t('waiting.seeInstead')}</Text>
                <Icon icon={ChevronRight} size={14} color="jade" />
              </Pressable>
            ) : null}
          </View>
          <View className="items-end gap-[4px]">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('map.placeSearchView')}
              onPress={() => onView(item)}
              hitSlop={{ top: 8, bottom: 8, left: 2, right: 2 }}
              className="rounded-full border px-[10px] py-[6px]"
              style={{ borderColor: 'rgba(193, 154, 62, 0.5)' }}
            >
              <Text className="text-[11px] text-gold-deep" weight="semibold">{t('map.placeSearchView')}</Text>
            </Pressable>
            {item.placeUrl ? (
              <Pressable accessibilityRole="link" onPress={() => onOpenKakao(item)} hitSlop={{ top: 10, bottom: 10, left: 4, right: 4 }} className="px-[4px]">
                {/* 웹은 밑줄이 없다(hover 때만 — 터치에는 hover 가 없다). */}
                <Text className="text-[10px] text-muk-soft" weight="semibold">{t('map.searchKakaoPlace')}</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ))}
    </ResultsPanel>
  );
}

/** 관광공사 결과(G2-21) — jade 테두리·아이콘, 사진 48, 채운 jade '지도에서 보기' · jade 외곽 길찾기 · 회색 '다음 배치 추가 요청'(접수되면 잠김). */
export function TourSearchResults({ items, loading, requested, pendingId, onView, onRoute, onRequestIngest }: {
  items: readonly TourApiSearchItem[];
  loading: boolean;
  requested: ReadonlySet<string>;
  pendingId: string | null;
  onView: (item: TourApiSearchItem) => void;
  onRoute: (item: TourApiSearchItem) => void;
  onRequestIngest: (item: TourApiSearchItem) => void;
}) {
  const t = useT();
  const [failedPhotos, setFailedPhotos] = useState<ReadonlySet<string>>(new Set());
  if (!loading && items.length === 0) return null;
  return (
    <ResultsPanel title={t('map.tourApiTitle')} source={t('map.tourApiSource')} tone="jade" loading={loading}>
      {items.map((item, i) => {
        const hasPoint = typeof item.mapy === 'number' && typeof item.mapx === 'number';
        const done = requested.has(item.contentid);
        const pending = pendingId === item.contentid;
        const photo = failedPhotos.has(item.contentid) ? null : toHttpsImageUrl(item.firstimage);
        return (
          <View key={item.contentid} className={`flex-row items-start gap-[12px] px-[12px] py-[10px] ${i > 0 ? 'border-t border-line/60' : ''}`}>
            {photo ? (
              <Image
                source={{ uri: photo }}
                accessibilityIgnoresInvertColors
                onError={() => setFailedPhotos((prev) => new Set(prev).add(item.contentid))}
                style={{ width: 48, height: 48, borderRadius: 12, borderWidth: 1, borderColor: colors.line }}
                contentFit="cover"
              />
            ) : null}
            <View className="min-w-0 flex-1">
              <Text className="text-sm" weight="medium" numberOfLines={1}>{item.title}</Text>
              {item.addr1 ? <Text className="text-[11px] text-muk-soft" numberOfLines={1}>{item.addr1}</Text> : null}
              <View className="mt-[8px] flex-row flex-wrap items-center gap-[6px]">
                {hasPoint ? (
                  <>
                    <Pressable accessibilityRole="button" onPress={() => onView(item)} hitSlop={{ top: 8, bottom: 8, left: 2, right: 2 }} className="rounded-full bg-jade px-[10px] py-[6px]">
                      <Text className="text-[11px] text-white" weight="bold">{t('map.placeSearchView')}</Text>
                    </Pressable>
                    <Pressable accessibilityRole="button" onPress={() => onRoute(item)} hitSlop={{ top: 8, bottom: 8, left: 2, right: 2 }} className="rounded-full border px-[10px] py-[6px]" style={{ borderColor: 'rgba(62, 124, 106, 0.5)' }}>
                      <Text className="text-[11px] text-jade" weight="semibold">{t('map.searchKakaoRoute')}</Text>
                    </Pressable>
                  </>
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: done || pending }}
                  disabled={done || pending}
                  onPress={() => onRequestIngest(item)}
                  hitSlop={{ top: 8, bottom: 8, left: 2, right: 2 }}
                  className="rounded-full border border-line px-[10px] py-[6px]"
                  style={done || pending ? { opacity: 0.6 } : undefined}
                >
                  <Text className="text-[11px] text-muk-soft" weight="semibold">
                    {done ? t('map.ingestRequested') : pending ? `${t('map.ingestRequest')}…` : t('map.ingestRequest')}
                  </Text>
                </Pressable>
              </View>
            </View>
          </View>
        );
      })}
    </ResultsPanel>
  );
}

// ── 위치 ──────────────────────────────────────────────────────────────

/** 시스템 창 앞 안내 — HIG: 버튼은 '계속' 하나, 빠져나가는 버튼을 두지 않는다(계획 §6.2 ②). */
export function LocationPrimer({ onContinue }: { onContinue: () => void }) {
  const t = useT();
  return (
    <View className="absolute inset-0 items-center justify-center bg-muk/35 px-[24px]" accessibilityViewIsModal>
      <Card elevation="surface" className="w-full max-w-[360px] items-center gap-[12px]">
        <Text className="text-[34px]" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">📍</Text>
        <Text className="text-center text-[18px]" weight="bold" accessibilityRole="header">{t('app.home.locationPrimer.title')}</Text>
        <Text className="text-center text-[14px] leading-[21px] text-muk-soft">{t('app.home.locationPrimer.body')}</Text>
        <Button block variant="primary" label={t('app.home.locationPrimer.continue')} onPress={onContinue} />
      </Card>
    </View>
  );
}
