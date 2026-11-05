// 지도 위 보조 칩 넷 — 날씨 · 축제 · 화장실 · 지금 한산. 각자 자료를 받아 비어 있으면 스스로 숨는다(웹과 같다).
// 웹 원본(0d145a1): apps/web/components/main/{WeatherChip,FestivalBanner,RestroomChip,TodayCalmSpots}.tsx
// 바꾼 것: 포털 모달·펼침 판 → ModalSheet, hover·ring 버림, framer-motion 버림, 포스터는 expo-image,
//          링크는 lib/platform/links(카카오맵 앱 → 없으면 시스템 브라우저), 날씨 '실내만' 은 홈이 조건 상태를 들고 있다.
import { Image } from 'expo-image';
import { CalendarDays, ExternalLink, Leaf, Map as MapIcon, MapPin, Phone, Toilet, Umbrella } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { Linking, View } from 'react-native';

import { festivalBannerModel, festivalDateLabel, festivalTriggerVisible } from '@/lib/festivalBanner';
import { formatDistance, haversineMeters } from '@/lib/map/geo';
import { Icon, ModalSheet, Pressable, SheetScrollView, Text } from '~/components/ui';
import { apiClient } from '~/lib/core/apiClient';
import { useI18n } from '~/lib/i18n/I18nProvider';
import { openExternalUrl, openKakaoHandoff } from '~/lib/platform/links';
import { toHttpsImageUrl } from '~/lib/platform/images';
import { telHref } from '@/lib/phoneLink';

import { calmKey, calmSpots, type CalmSpot, type HomeFacility } from './homeModel';

/** 칩은 보이는 높이가 36pt 다 — 위아래 4pt 씩 넓혀 44pt 탭 영역을 채운다(디자인 규칙 11, 웹 .tap-target). */
export const CHIP_HIT_SLOP = { top: 4, bottom: 4, left: 0, right: 0 } as const;

const CHIP = 'min-h-[36px] shrink-0 flex-row items-center gap-[6px] rounded-full border border-line bg-white px-[12px] py-[6px]';
const LIST_MAX_HEIGHT = 420;
type Point = { lat: number; lng: number };

function SheetHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View className="mb-[12px] gap-[2px]">
      <Text className="text-[18px]" weight="bold" accessibilityRole="header">{title}</Text>
      {subtitle ? <Text className="text-[12px] text-muk-soft">{subtitle}</Text> : null}
    </View>
  );
}

// ── 날씨 ────────────────────────────────────────────────────────────────

interface WeatherNow { at: string; temperatureC: number; sky: number; precipitationType: number; precipitationProbability: number; windSpeedMps: number }
interface WeatherResponse { source: 'kma' | 'unavailable'; current: WeatherNow | null; forecasts: WeatherNow[]; indoorRecommended: boolean }

function weatherIcon(now: WeatherNow): string {
  if (now.precipitationType === 3 || now.precipitationType === 7) return '❄️';
  if (now.precipitationType > 0) return '🌧️';
  if (now.sky >= 4) return '☁️';
  if (now.sky >= 3) return '⛅';
  return '☀️';
}

export function WeatherChip({ indoorRequired, onIndoorRequiredChange }: { indoorRequired: boolean; onIndoorRequiredChange: (required: boolean) => void }) {
  const { t, locale } = useI18n();
  const [data, setData] = useState<WeatherResponse | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let active = true;
    apiClient.get('/api/v1/weather').then((value: WeatherResponse) => { if (active) setData(value); }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  if (!data?.current || data.source !== 'kma') return null;
  const now = data.current;
  const hourOf = (value: string) => {
    try { return new Intl.DateTimeFormat(locale, { hour: 'numeric' }).format(new Date(value)); } catch { return ''; }
  };
  const full = t('weather.gyeongjuNow', { n: Math.round(now.temperatureC) });
  const summary = data.indoorRecommended
    ? t('weather.riskSummary', { n: now.precipitationProbability })
    : t('weather.calmSummary', { n: now.precipitationProbability });
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${full} · ${summary}`}
        onPress={() => setOpen(true)}
        hitSlop={CHIP_HIT_SLOP} className={`${CHIP} ${data.indoorRecommended ? 'border-gold' : ''}`}
      >
        <Text className="text-[15px]" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{weatherIcon(now)}</Text>
        <Text className="text-[12px]" weight="bold" numberOfLines={1}>{full}</Text>
        {data.indoorRecommended ? <Icon icon={Umbrella} size="sm" color="gold-deep" /> : null}
      </Pressable>
      <ModalSheet open={open} onClose={() => setOpen(false)} handleLabel={t('common.close')} closeLabel={t('common.close')}>
        <Text className="text-[14px]" weight="semibold">{summary}</Text>
        <View className="mt-[10px] flex-row" accessibilityLabel={t('weather.sixHour')}>
          {data.forecasts.slice(0, 6).map((f) => (
            <View key={f.at} className="min-h-[64px] flex-1 items-center">
              <Text className="text-[11px] text-muk-soft">{hourOf(f.at)}</Text>
              <Text className="my-[2px] text-[18px]" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{weatherIcon(f)}</Text>
              <Text className="text-[12px]" weight="semibold">{`${Math.round(f.temperatureC)}°`}</Text>
            </View>
          ))}
        </View>
        <Text className="mt-[8px] text-[11px] text-muk-soft">{t('weather.observedAt', { time: hourOf(now.at) })}</Text>
        {data.indoorRecommended || indoorRequired ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: indoorRequired }}
            onPress={() => onIndoorRequiredChange(!indoorRequired)}
            className={`mt-[12px] min-h-[44px] flex-row items-center justify-center gap-[8px] rounded-xl border ${indoorRequired ? 'border-jade bg-jade/15' : 'border-gold/50 bg-gold/10'}`}
          >
            <Icon icon={Umbrella} size="md" color={indoorRequired ? 'jade' : 'muk'} />
            <Text className="text-[13px]" weight="bold">{t('setup.indoorOnly')}</Text>
          </Pressable>
        ) : null}
      </ModalSheet>
    </>
  );
}

// ── 축제 ────────────────────────────────────────────────────────────────

export interface FestivalEvent {
  contentId: string;
  title: string;
  startDate: string;
  endDate: string;
  address?: string | null;
  imageUrl?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  tel?: string | null;
  isOngoing: boolean;
  overview?: string | null;
  homepage?: string | null;
  playtime?: string | null;
  eventPlace?: string | null;
  usetimeFestival?: string | null;
  overviewI18n?: Record<string, string> | null;
}

const EVENTS_TTL_MS = 6 * 60 * 60 * 1000;
let eventsCache: { at: number; events: FestivalEvent[] } | null = null;
let eventsInflight: Promise<FestivalEvent[] | null> | null = null;

/** 화면당 한 번 — 여러 곳이 마운트돼도 같은 요청을 기다린다. 실패는 null('숨김'). */
function loadFestivalEvents(): Promise<FestivalEvent[] | null> {
  if (eventsCache && Date.now() - eventsCache.at < EVENTS_TTL_MS) return Promise.resolve(eventsCache.events);
  if (eventsInflight) return eventsInflight;
  const request = (async () => {
    try {
      const res = await apiClient.get('/api/v1/events');
      if (res?.source !== 'tourapi' || !Array.isArray(res.events)) return null;
      eventsCache = { at: Date.now(), events: res.events as FestivalEvent[] };
      return eventsCache.events;
    } catch {
      return null;
    }
  })();
  eventsInflight = request;
  void request.finally(() => { if (eventsInflight === request) eventsInflight = null; });
  return request;
}

function extractHomepageUrl(raw?: string | null): string | null {
  if (!raw) return null;
  return String(raw).match(/https?:\/\/[^\s"'<>]+/)?.[0] ?? null;
}

export function FestivalChip({ location, onFocus }: { location: Point; onFocus: (event: FestivalEvent) => void }) {
  const { t, locale } = useI18n();
  const [events, setEvents] = useState<FestivalEvent[] | null>(null);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    void loadFestivalEvents().then((list) => { if (!cancelled) setEvents(list); });
    return () => { cancelled = true; };
  }, []);
  if (!events || !festivalTriggerVisible('chip', events)) return null;
  const model = festivalBannerModel(events);
  const dateLabel = (iso: string) => festivalDateLabel(iso, locale);
  const distanceText = (ev: FestivalEvent) => {
    if (ev.latitude == null || ev.longitude == null) return null;
    const m = haversineMeters(location.lat, location.lng, ev.latitude, ev.longitude);
    return Number.isFinite(m) ? formatDistance(m) : null;
  };
  return (
    <>
      {model ? (
        // 진행 중인 축제가 있으면 한 줄 배너 모양(웹 compact) — 이름은 한국어 원문뿐이라 ko 에서만 쓴다.
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('festival.bannerAria', { title: model.first.title })}
          onPress={() => setOpen(true)}
          hitSlop={CHIP_HIT_SLOP} className={`${CHIP} max-w-[260px] border-terracotta/35`}
        >
          <Text className="text-[13px]" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">🏮</Text>
          <Text className="shrink text-[12px]" weight="semibold" numberOfLines={1}>
            {locale === 'ko' ? model.first.title : t('festival.bannerLabel')}
          </Text>
          <Text className="text-[12px] text-muk-soft" numberOfLines={1}>{`· ${t('festival.bannerUntil', { date: dateLabel(model.first.endDate) })}`}</Text>
        </Pressable>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('festival.chipAria', { n: String(events.length) })}
          onPress={() => setOpen(true)}
          hitSlop={CHIP_HIT_SLOP} className={CHIP}
        >
          <Text className="text-[13px]" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">🏮</Text>
          <Text className="text-[13px] text-muk-soft" weight="medium">{t('festival.chip')}</Text>
          <Text className="text-[11px] text-gold-deep" weight="bold">{String(events.length)}</Text>
        </Pressable>
      )}
      <ModalSheet open={open} onClose={() => setOpen(false)} handleLabel={t('common.close')} closeLabel={t('common.close')}>
        <SheetHeader title={`🏮 ${t('festival.title')}`} subtitle={t('festival.subtitle')} />
        <SheetScrollView style={{ maxHeight: LIST_MAX_HEIGHT }} contentContainerStyle={{ gap: 12 }}>
          {events.map((ev) => {
            const place = ev.eventPlace ?? ev.address ?? null;
            const distance = distanceText(ev);
            const homepage = extractHomepageUrl(ev.homepage);
            const aiSummary = locale !== 'ko' ? (ev.overviewI18n?.[locale] ?? null) : null;
            const overview = aiSummary ?? ev.overview ?? null;
            const isExpanded = expanded.has(ev.contentId);
            const poster = toHttpsImageUrl(ev.imageUrl);
            const tel = telHref(ev.tel);
            return (
              <View key={ev.contentId} className="overflow-hidden rounded-2xl border border-line bg-white">
                {poster ? <Image source={{ uri: poster }} accessibilityIgnoresInvertColors style={{ height: 96, width: '100%' }} contentFit="cover" /> : null}
                <View className="gap-[8px] p-[14px]">
                  <View className="flex-row flex-wrap items-center gap-[8px]">
                    <View className={`rounded-full px-[8px] py-[2px] ${ev.isOngoing ? 'bg-terracotta/15' : 'bg-jade/15'}`}>
                      <Text className={`text-[11px] ${ev.isOngoing ? 'text-terracotta' : 'text-jade'}`} weight="bold">
                        {ev.isOngoing ? t('festival.ongoing') : t('festival.upcoming')}
                      </Text>
                    </View>
                    <Icon icon={CalendarDays} size="xs" color="muk-soft" />
                    <Text className="text-[12px] text-muk-soft">{`${dateLabel(ev.startDate)} ~ ${dateLabel(ev.endDate)}`}</Text>
                    {distance ? <Text className="text-[12px] text-gold-deep" weight="bold">{distance}</Text> : null}
                  </View>
                  <Text className="text-[14px]" weight="bold">{ev.title}</Text>
                  {place ? (
                    <View className="flex-row items-start gap-[4px]">
                      <Icon icon={MapPin} size="xs" color="muk-soft" />
                      <Text className="flex-1 text-[12px] text-muk-soft">{place}</Text>
                    </View>
                  ) : null}
                  {ev.playtime ? <Text className="text-[12px] text-muk-soft">{`🕐 ${ev.playtime}`}</Text> : null}
                  {ev.usetimeFestival ? <Text className="text-[12px] text-muk-soft">{`💰 ${ev.usetimeFestival}`}</Text> : null}
                  {overview ? (
                    <View className="gap-[4px]">
                      <Text className="text-[11px] text-muk-soft" weight="bold">
                        {aiSummary ? `${t('festival.about')} · ${t('festival.aiSummary')}` : t('festival.about')}
                      </Text>
                      <Text className="text-[12px] leading-[18px] text-muk-soft" numberOfLines={isExpanded ? undefined : 3}>{overview}</Text>
                      {overview.length > 90 ? (
                        <Pressable
                          accessibilityRole="button"
                          className="min-h-[44px] justify-center"
                          onPress={() => setExpanded((prev) => {
                            const next = new Set(prev);
                            if (next.has(ev.contentId)) next.delete(ev.contentId); else next.add(ev.contentId);
                            return next;
                          })}
                        >
                          <Text className="text-[12px] text-gold-deep" weight="bold">{isExpanded ? t('festival.showLess') : t('festival.showMore')}</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  ) : null}
                  <View className="flex-row flex-wrap gap-[8px]">
                    {ev.latitude != null && ev.longitude != null ? (
                      <>
                        <ActionPill icon={MapIcon} label={t('compare.showOnMap')} accessibilityLabel={t('festival.showOnMapAria', { title: ev.title })} gold
                          onPress={() => { onFocus(ev); setOpen(false); }} />
                        <ActionPill icon={ExternalLink} label={t('festival.openMap')}
                          onPress={() => void openExternalUrl(`https://map.kakao.com/link/map/${encodeURIComponent(ev.title)},${ev.latitude},${ev.longitude}`)} />
                      </>
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
    </>
  );
}

function ActionPill({ icon, label, onPress, gold, accessibilityLabel }: {
  icon: typeof MapIcon; label: string; onPress: () => void; gold?: boolean; accessibilityLabel?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      className={`min-h-[44px] flex-row items-center gap-[4px] rounded-full border px-[12px] ${gold ? 'border-gold/40 bg-gold/15' : 'border-line bg-hanji-deep'}`}
    >
      <Icon icon={icon} size="xs" color={gold ? 'gold-deep' : 'muk-soft'} />
      <Text className={`text-[12px] ${gold ? 'text-gold-deep' : 'text-muk-soft'}`} weight="bold">{label}</Text>
    </Pressable>
  );
}

// ── 화장실 ──────────────────────────────────────────────────────────────

interface Restroom { id: string; name: string; address: string; latitude: number; longitude: number; distanceM: number; placeUrl: string }

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
      <Pressable accessibilityRole="button" accessibilityLabel={t('restroom.chipAria', { n: items.length })} onPress={() => setOpen(true)} hitSlop={CHIP_HIT_SLOP} className={CHIP}>
        <Icon icon={Toilet} size="sm" color="muk-soft" />
        <Text className="text-[13px] text-muk-soft" weight="medium">{`${t('restroom.chip')} ${items.length}`}</Text>
      </Pressable>
      <ModalSheet open={open} onClose={() => setOpen(false)} handleLabel={t('common.close')} closeLabel={t('common.close')}>
        <SheetHeader title={t('restroom.title')} subtitle={t('restroom.subtitle')} />
        <SheetScrollView style={{ maxHeight: LIST_MAX_HEIGHT }} contentContainerStyle={{ gap: 8 }}>
          {items.map((item) => (
            <Pressable
              key={item.id}
              accessibilityRole="link"
              accessibilityLabel={`${item.name}, ${item.distanceM < 1000 ? `${item.distanceM}m` : `${(item.distanceM / 1000).toFixed(1)}km`}`}
              onPress={() => {
                const handoff = { app: null, web: item.placeUrl || `https://map.kakao.com/link/map/${encodeURIComponent(item.name)},${item.latitude},${item.longitude}` };
                void openKakaoHandoff(handoff);
              }}
              className="min-h-[56px] flex-row items-center justify-between gap-[12px] rounded-2xl border border-line bg-white px-[12px] py-[10px]"
            >
              <View className="min-w-0 flex-1">
                <Text className="text-[14px]" weight="bold" numberOfLines={1}>{item.name}</Text>
                <Text className="text-[12px] text-muk-soft" numberOfLines={1}>{item.address}</Text>
              </View>
              <Text className="text-[12px] text-gold-deep" weight="bold">
                {item.distanceM < 1000 ? `${item.distanceM}m` : `${(item.distanceM / 1000).toFixed(1)}km`}
              </Text>
            </Pressable>
          ))}
        </SheetScrollView>
      </ModalSheet>
    </>
  );
}

// ── 지금 한산 ───────────────────────────────────────────────────────────

export function CalmChip({ facilities, location, onFocus }: { facilities: readonly HomeFacility[]; location: Point; onFocus: (spot: CalmSpot) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const spots = useMemo(() => calmSpots(facilities, location), [facilities, location]);
  if (spots.length === 0) return null;
  return (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel={t('calm.chipAria', { n: String(spots.length) })} onPress={() => setOpen(true)} hitSlop={CHIP_HIT_SLOP} className={CHIP}>
        <Text className="text-[13px]" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">🍃</Text>
        <Text className="text-[13px] text-muk-soft" weight="medium">{t('calm.chip')}</Text>
        <Text className="text-[11px] text-jade" weight="bold">{String(spots.length)}</Text>
      </Pressable>
      <ModalSheet open={open} onClose={() => setOpen(false)} handleLabel={t('common.close')} closeLabel={t('common.close')}>
        <SheetHeader title={`🍃 ${t('calm.title')}`} subtitle={t('calm.subtitle')} />
        <View className="gap-[12px]">
          {spots.map((spot) => (
            <Pressable
              key={spot.id}
              accessibilityRole="button"
              accessibilityLabel={t('calm.showOnMapAria', { name: spot.name })}
              onPress={() => { onFocus(spot); setOpen(false); }}
              className="min-h-[64px] flex-row items-center gap-[12px] rounded-2xl border border-line bg-white p-[14px]"
            >
              <View className="h-[36px] w-[36px] items-center justify-center rounded-full border border-jade/25 bg-jade/10">
                <Icon icon={Leaf} size="lg" color="jade" />
              </View>
              <View className="min-w-0 flex-1">
                <Text className="text-[14px]" weight="bold" numberOfLines={1}>{spot.name}</Text>
                <View className="mt-[4px] flex-row flex-wrap items-center gap-[6px]">
                  <Text className="rounded-md bg-hanji-deep px-[6px] py-[2px] text-[11px] text-muk-soft" weight="semibold">{t(`category.${spot.type}`)}</Text>
                  <Text className="rounded-md border border-jade/25 bg-jade/10 px-[6px] py-[2px] text-[11px] text-jade" weight="bold">{t(`congestion.${calmKey(spot.congestionLevel)}`)}</Text>
                  {Number.isFinite(spot.distM) ? <Text className="text-[11px] text-muk-soft">{formatDistance(spot.distM)}</Text> : null}
                </View>
              </View>
            </Pressable>
          ))}
        </View>
      </ModalSheet>
    </>
  );
}
