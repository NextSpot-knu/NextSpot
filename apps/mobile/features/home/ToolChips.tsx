// 지도 위 보조 칩 — 날씨(유리 알약 + 팝오버) · 화장실. 각자 자료를 받아 비어 있으면 스스로 숨는다(웹과 같다).
// 웹 원본(0d145a1): apps/web/components/main/{WeatherChip,RestroomChip}.tsx
// 바꾼 것: 포털 모달 → ModalSheet, hover·ring·framer-motion 버림, 포스터는 expo-image, 링크는 lib/platform/links(카카오맵 앱 → 시스템 브라우저).
// H2a(G2-13·15·16·17·18): 날씨 칩은 유리 알약 + ▾, 펼침은 칩 아래 팝오버(자리는 홈 루트 — 아래 '연결'), 축제·화장실은 웹 모양 칩 + 시트(축제는 festival.ts·
// FestivalSheet.tsx·FestivalBanner.tsx 로 추출). 지금 한산은 폰 폭에서 그리지 않는다(웹은 lg 이상만 — H3b 에서 지웠다).
//
// 홈 연결: 첫 칩 줄 = `useWeather()` 자료로 `<WeatherPill … />`(+ ✨ 는 F2) 한 줄(가로 스크롤 아님). 팝오버는 HomeScreen 루트의
// 여정 판·아래 스택·시트보다 위 층에 `<WeatherPopover … />`(스크롤·클리핑 회피). 축제·화장실 칩은 ToolsSheet(HomeOverlays) 안에 있다.
import { ChevronDown, ChevronUp, MapPin, Toilet, Umbrella } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { BackHandler, Pressable as RNPressable, View, useWindowDimensions } from 'react-native';

import { Glass, Icon, MODAL_SHEET_CLOSE_BOX, ModalSheet, Pressable, SheetScrollView, Text } from '~/components/ui';
import { apiClient } from '~/lib/core/apiClient';
import { useI18n } from '~/lib/i18n/I18nProvider';
import { openKakaoHandoff } from '~/lib/platform/links';

import type { FestivalEvent } from './festival';
import { kstHourLabel, type ClockLocale } from './kstClock';

export type { FestivalEvent };

/** 칩은 보이는 높이가 36pt 다 — 위아래 4pt 씩 넓혀 44pt 탭 영역을 채운다(디자인 규칙 11, 웹 .tap-target). */
export const CHIP_HIT_SLOP = { top: 4, bottom: 4, left: 0, right: 0 } as const;

/** 웹 시트 칩(fractal-glass 흰 80%) — 필터·편의 시트 맨 아래 줄의 화장실·축제. */
export const SHEET_CHIP_CLASS = 'shrink-0 flex-row items-center gap-[8px] rounded-full border border-line px-[14px] py-[8px]';
export const SHEET_CHIP_STYLE = { backgroundColor: 'rgba(255, 255, 255, 0.8)', boxShadow: '0px 2px 14px rgba(43, 35, 32, 0.06)' } as const;
type Point = { lat: number; lng: number };

function SheetHeader({ title, subtitle, closeBox }: { title: string; subtitle?: string; closeBox?: number }) {
  return (
    <View className="mb-[16px]" style={closeBox ? { paddingRight: closeBox + 12 } : undefined}>
      <Text className="text-[18px]" weight="bold" accessibilityRole="header">{title}</Text>
      {subtitle ? <Text className="text-[12px] text-muk-soft">{subtitle}</Text> : null}
    </View>
  );
}

// ── 날씨 ────────────────────────────────────────────────────────────────

interface WeatherNow { at: string; temperatureC: number; sky: number; precipitationType: number; precipitationProbability: number; windSpeedMps: number }
export interface WeatherData { source: 'kma' | 'unavailable'; current: WeatherNow | null; forecasts: WeatherNow[]; indoorRecommended: boolean }
/** 팝오버를 붙일 칩의 창 좌표(measureInWindow). */
export interface PillAnchor { x: number; y: number; width: number; height: number }

function weatherIcon(now: WeatherNow): string {
  if (now.precipitationType === 3 || now.precipitationType === 7) return '❄️';
  if (now.precipitationType > 0) return '🌧️';
  if (now.sky >= 4) return '☁️';
  if (now.sky >= 3) return '⛅';
  return '☀️';
}

/** 날씨 자료 — 받지 못했거나 KMA 가 아니면 null(칩을 그리지 않는다). */
export function useWeather(): WeatherData | null {
  const [data, setData] = useState<WeatherData | null>(null);
  useEffect(() => {
    let active = true;
    apiClient.get('/api/v1/weather').then((value: WeatherData) => { if (active) setData(value); }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  return data?.current && data.source === 'kma' ? data : null;
}

function useHourOf() {
  const { locale } = useI18n();
  return (value: string) => {
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? '' : kstHourLabel(at, locale as ClockLocale);
  };
}

function summaryOf(data: WeatherData, t: ReturnType<typeof useI18n>['t']): string {
  const now = data.current as WeatherNow;
  return data.indoorRecommended
    ? t('weather.riskSummary', { n: now.precipitationProbability })
    : t('weather.calmSummary', { n: now.precipitationProbability });
}

/**
 * 날씨 알약(G2-15) — 유리 · 높이 32 · px 12 · gap 6 · 12 bold · 이모지 15 · 끝 ▾/▴ 14. 실내 추천이면 우산 13 + 금 테두리 60%.
 * 키 낮은 폰(높이 720 미만)은 '지금 경주' 를 빼고 `{n}℃` 만(웹 short:max-md). 누르면 칩의 창 좌표와 함께 onToggle.
 */
export function WeatherPill({ data, expanded, onToggle }: { data: WeatherData; expanded: boolean; onToggle: (anchor: PillAnchor) => void }) {
  const { t } = useI18n();
  const { height } = useWindowDimensions();
  const ref = useRef<View>(null);
  const now = data.current as WeatherNow;
  const full = t('weather.gyeongjuNow', { n: Math.round(now.temperatureC) });
  const summary = summaryOf(data, t);
  const short = height < 720;
  return (
    <View ref={ref} collapsable={false} className="shrink-0 self-start">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${full} · ${summary}`}
        accessibilityState={{ expanded }}
        hitSlop={CHIP_HIT_SLOP}
        onPress={() => {
          ref.current?.measureInWindow((x, y, width, h) => onToggle({ x, y, width, height: h }));
        }}
      >
        <Glass
          className="h-[32px] flex-row items-center gap-[6px] px-[12px]"
          // 유리 테두리가 클래스 색을 덮으므로 실내 추천의 금 테두리는 style 로 지킨다(웹 인라인 borderColor).
          style={data.indoorRecommended ? { borderColor: 'rgba(193, 154, 62, 0.6)' } : undefined}
        >
          <Text className="text-[15px] leading-none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{weatherIcon(now)}</Text>
          <Text className="text-[12px]" weight="bold" numberOfLines={1}>{short ? `${Math.round(now.temperatureC)}℃` : full}</Text>
          {data.indoorRecommended ? <Icon icon={Umbrella} size={13} color="gold-deep" /> : null}
          <Icon icon={expanded ? ChevronUp : ChevronDown} size={14} color="muk" />
        </Glass>
      </Pressable>
    </View>
  );
}

/** 예보 내용(요약 · 6칸 · 관측 · 실내만) — 팝오버와 옛 시트가 같이 쓴다. */
function WeatherDetails({ data, indoorRequired, onIndoorRequiredChange }: { data: WeatherData; indoorRequired: boolean; onIndoorRequiredChange: (required: boolean) => void }) {
  const { t } = useI18n();
  const hourOf = useHourOf();
  const now = data.current as WeatherNow;
  return (
    <>
      <Text className="text-[12px]" weight="semibold">{summaryOf(data, t)}</Text>
      <View className="mt-[8px] flex-row gap-[4px]" accessibilityLabel={t('weather.sixHour')}>
        {data.forecasts.slice(0, 6).map((f) => (
          <View key={f.at} className="flex-1 items-center">
            <Text className="text-[10px] text-muk-soft">{hourOf(f.at)}</Text>
            <Text className="my-[2px] text-[16px]" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{weatherIcon(f)}</Text>
            <Text className="text-[10px]" weight="semibold">{`${Math.round(f.temperatureC)}°`}</Text>
          </View>
        ))}
      </View>
      <Text className="mt-[8px] text-[10px] text-muk-soft">{t('weather.observedAt', { time: hourOf(now.at) })}</Text>
      {data.indoorRecommended || indoorRequired ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: indoorRequired }}
          onPress={() => onIndoorRequiredChange(!indoorRequired)}
          className={`mt-[10px] flex-row items-center justify-center gap-[8px] rounded-xl border px-[12px] py-[8px] ${indoorRequired ? 'border-jade bg-jade/15' : 'border-gold/50 bg-gold/10'}`}
        >
          <Icon icon={Umbrella} size={14} color={indoorRequired ? 'jade' : 'muk'} />
          <Text className={`text-[12px] ${indoorRequired ? 'text-jade' : 'text-muk'}`} weight="bold">{t('setup.indoorOnly')}</Text>
        </Pressable>
      ) : null}
    </>
  );
}

/**
 * 날씨 팝오버(G2-16) — 칩 아래 288 폭 판, 화면 안으로 밀기, 바깥을 누르면 닫힘. HomeScreen 루트(부모가 화면 전체)에 둔다 —
 * 칩 줄 가로 ScrollView 안에 두면 잘리고 부모 밖 터치가 막힌다(R1). 웹 값: rounded-2xl border-line bg-white px-3.5 pb-3 pt-2.5 mt-2.
 */
export function WeatherPopover({ data, anchor, indoorRequired, onIndoorRequiredChange, onClose }: {
  data: WeatherData;
  anchor: PillAnchor;
  indoorRequired: boolean;
  onIndoorRequiredChange: (required: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { width: screenW } = useWindowDimensions();
  const width = Math.min(288, screenW - 32);
  // 웹 popoverLeft — 칩 왼쪽 끝에 붙이되 오른쪽 16 여백을 넘으면 그만큼 왼쪽으로, 왼쪽 16 안으로.
  const shift = Math.max(16 - anchor.x, Math.min(0, screenW - 16 - (anchor.x + width)));
  // 안드로이드 뒤로 가기는 팝오버부터 닫는다(화면을 떠나지 않는다).
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);
  return (
    <View
      pointerEvents="box-none"
      accessibilityViewIsModal
      onAccessibilityEscape={onClose}
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 60 }}>
      <RNPressable accessibilityRole="button" accessibilityLabel={t('common.close')} onPress={onClose} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
      <View
        className="absolute rounded-2xl border border-line bg-white px-[14px] pb-[12px] pt-[10px]"
        style={{ top: anchor.y + anchor.height + 8, left: anchor.x + shift, width, boxShadow: '0px 10px 30px rgba(43, 35, 32, 0.18)' }}
      >
        <WeatherDetails data={data} indoorRequired={indoorRequired} onIndoorRequiredChange={onIndoorRequiredChange} />
      </View>
    </View>
  );
}

// ── 축제 ────────────────────────────────────────────────────────────────

// ── 화장실 ──────────────────────────────────────────────────────────────

interface Restroom { id: string; name: string; address: string; latitude: number; longitude: number; distanceM: number; placeUrl: string }

function distanceText(m: number): string {
  return m < 1000 ? `${m}m` : `${(m / 1000).toFixed(1)}km`;
}

/** 화장실 시트(G2-18) — 웹 RestroomChip 패널: 막 black/30 · max-h 70vh · max-w-lg · hanji · p-5, 줄 rounded-2xl border-line bg-white/70 p-3. */
export function RestroomSheet({ open, onClose, items }: { open: boolean; onClose: () => void; items: readonly Restroom[] }) {
  const { t } = useI18n();
  const { height } = useWindowDimensions();
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
      maxHeight={Math.round(height * 0.7)}
      contentPadding={{ x: 20, top: 20, bottom: 20 }}
      stackBehavior="push"
    >
      <SheetHeader title={t('restroom.title')} subtitle={t('restroom.subtitle')} closeBox={MODAL_SHEET_CLOSE_BOX.plain} />
      <SheetScrollView style={{ maxHeight: Math.round(height * 0.7) - 130 }} contentContainerStyle={{ gap: 8 }}>
        {items.map((item) => (
          <Pressable
            key={item.id}
            accessibilityRole="link"
            accessibilityLabel={`${item.name}, ${distanceText(item.distanceM)}`}
            onPress={() => {
              void openKakaoHandoff({ app: null, web: item.placeUrl || `https://map.kakao.com/link/map/${encodeURIComponent(item.name)},${item.latitude},${item.longitude}` });
            }}
            className="flex-row items-center justify-between rounded-2xl border border-line p-[12px]"
            style={{ backgroundColor: 'rgba(255, 255, 255, 0.7)' }}
          >
            <View className="min-w-0 flex-1">
              <Text className="text-[14px]" weight="bold" numberOfLines={1}>{item.name}</Text>
              <Text className="text-[12px] text-muk-soft" numberOfLines={1}>{item.address}</Text>
            </View>
            <View className="ml-[12px] flex-row items-center gap-[4px]">
              <Icon icon={MapPin} size={13} color="gold-deep" />
              <Text className="text-[12px] text-gold-deep" weight="bold">{distanceText(item.distanceM)}</Text>
            </View>
          </Pressable>
        ))}
      </SheetScrollView>
    </ModalSheet>
  );
}

/** 화장실 칩 — 웹 모양(흰 80% 알약 · Toilet 15 · 13 medium). 3km 안 화장실이 없으면 숨는다. */
export function RestroomChip({ location }: { location: Point }) {
  const { t } = useI18n();
  const [items, setItems] = useState<Restroom[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let active = true;
    apiClient.get('/api/v1/restrooms', { params: { lat: String(location.lat), lng: String(location.lng), radiusM: '3000' } })
      .then((value: { restrooms?: Restroom[] }) => { if (active) setItems(value.restrooms || []); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [location.lat, location.lng]);
  if (!items.length) return null;
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('restroom.chipAria', { n: items.length })}
        onPress={() => setOpen(true)}
        hitSlop={CHIP_HIT_SLOP}
        className={SHEET_CHIP_CLASS}
        style={SHEET_CHIP_STYLE}
      >
        <Icon icon={Toilet} size={15} color="muk-soft" />
        <Text className="text-[13px] text-muk-soft" weight="medium">{`${t('restroom.chip')} ${items.length}`}</Text>
      </Pressable>
      <RestroomSheet open={open} onClose={() => setOpen(false)} items={items} />
    </>
  );
}
