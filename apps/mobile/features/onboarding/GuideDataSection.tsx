// 서비스 소개의 '데이터' 접힘 절 — 어느 공공 API 를 어느 화면에서 쓰는가 한 표 + TourAPI 신선도.
//
// 웹 원본: apps/web/components/guide/GuideDataSection.tsx, guide.module.css .planFold·.dataTable·.freshCard(모바일 값)
// (기준 커밋 0d145a1). 표의 오퍼레이션 이름은 웹 rows 상수 그대로(번역하지 않는 고유명사).
// 바꾼 것: <details> → 누름 줄 + 펼침 상태. 표는 RN 에 table 이 없어 가로 ScrollView 안 640 폭 행(웹 min-width 640 + overflow-x).
// 열 폭은 웹 자동 배치를 390 폭에서 잰 값에 가깝게 고정한다. 신선도는 공개 GET(apiClient.getFreshness) — 실패는 정적 문장.
import { ChevronDown, Database } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Platform, ScrollView, View, type LayoutChangeEvent } from 'react-native';

import { relativeParts } from '@/lib/freshness';
import { Icon, Pressable, Text } from '~/components/ui';
import { apiClient } from '~/lib/core/apiClient';
import { useT } from '~/lib/i18n/I18nProvider';

import { SectionHead } from './GuideSectionHead';

const ROWS = [
  { org: 'orgTour', api: 'apiLocation', ops: 'locationBasedList2 · areaBasedList2', screen: 'screenLocation', cycle: 'cycleDaily' },
  { org: 'orgTour', api: 'apiDetail', ops: 'detailCommon2 · detailIntro2', screen: 'screenDetail', cycle: 'cycleDailyLive' },
  { org: 'orgTour', api: 'apiImage', ops: 'detailImage2', screen: 'screenImage', cycle: 'cycleDaily' },
  { org: 'orgTour', api: 'apiFestival', ops: 'searchFestival2', screen: 'screenFestival', cycle: 'cycleOnRequest' },
  { org: 'orgTour', api: 'apiKeyword', ops: 'searchKeyword2', screen: 'screenKeyword', cycle: 'cycleOnRequest' },
  { org: 'orgLab', api: 'apiConcentration', ops: 'tatsCnctrRatedList', screen: 'screenConcentration', cycle: 'cycleDaily' },
  { org: 'orgKma', api: 'apiWeather', ops: 'getVilageFcst', screen: 'screenWeather', cycle: 'cycleWeather' },
  { org: 'orgParking', api: 'apiParking', ops: 'PrkSttusInfo · PrkRealtimeInfo', screen: 'screenParking', cycle: 'cycleParking' },
  { org: 'orgOsm', api: 'apiOsm', ops: 'Overpass API', screen: 'screenOsm', cycle: 'cycleStatic' },
  { org: 'orgKakao', api: 'apiKakao', ops: '/v2/local/search/keyword.json', screen: 'screenKakao', cycle: 'cycleLive' },
] as const;

/** 열 폭(합 640) — 웹 390 폭 자동 배치 실측(153.4 · 142.3 · 139.5 · 204.8): 출처 기관 · API(+오퍼레이션) · 적용 화면 · 갱신 주기. */
// 출처 기관 칸은 웹(750 굵기·nowrap)보다 앱 굵은 글자가 조금 넓어 160 으로, 그만큼 적용 화면 칸(줄바꿈 칸)에서 뺀다.
const COL = [160, 142, 133, 205] as const;
const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' });

type Freshness = Awaited<ReturnType<typeof apiClient.getFreshness>>;

export function GuideDataSection({
  initiallyOpen = false,
  onContentLayout,
}: {
  /** 랜딩 데이터 출처 줄로 열었으면 펼친 채로 시작한다. */
  initiallyOpen?: boolean;
  /** 펼친 절의 y(소개 본문 기준) — 모달이 그 자리로 스크롤한다. */
  onContentLayout?: (y: number) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(initiallyOpen);
  // null = 확인 중, false = 실패(정적 문장으로 폴백)
  const [freshness, setFreshness] = useState<Freshness | false | null>(null);

  useEffect(() => {
    let alive = true;
    apiClient
      .getFreshness()
      .then((res) => {
        if (alive) setFreshness(res ?? false);
      })
      .catch(() => {
        if (alive) setFreshness(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const parts = freshness ? relativeParts(freshness.lastTourapiSync) : null;
  const relative = !parts
    ? null
    : parts.unit === 'now'
      ? t('freshness.justNow')
      : parts.unit === 'min'
        ? t('freshness.minAgo', { n: parts.value })
        : parts.unit === 'hour'
          ? t('freshness.hourAgo', { n: parts.value })
          : t('freshness.dayAgo', { n: parts.value });

  const cell = 'border-b border-line px-[14px] py-[12px]';

  return (
    <View
      className="border-t border-line bg-hanji"
      onLayout={(e: LayoutChangeEvent) => {
        if (open) onContentLayout?.(e.nativeEvent.layout.y);
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((v) => !v)}
        className="flex-row items-center justify-center gap-[8px] px-[24px] py-[22px]"
      >
        <Icon icon={Database} size={17} color="gold-deep" />
        <Text className="text-[15px] leading-[22.5px] text-gold-deep" weight="bold">
          {t('dataTab.foldLabel')}
        </Text>
        <View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}>
          <Icon icon={ChevronDown} size={18} color="gold-deep" />
        </View>
      </Pressable>

      {open && (
        <View className="px-[20px] py-[48px]">
          <SectionHead kicker={t('dataTab.kicker')} title={t('dataTab.title')} />
          <Text className="mt-[18px] max-w-[660px] text-[15px] leading-[27px] text-muk-soft">{t('dataTab.summary')}</Text>

          <View className="mt-[30px] overflow-hidden rounded-[18px] border border-line bg-hanji">
            <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator accessibilityLabel={t('dataTab.tableCaption')}>
              <View style={{ width: 640 }}>
                <View className="flex-row bg-hanji-deep">
                  {(['colSource', 'colApi', 'colScreen', 'colCycle'] as const).map((k, i) => (
                    <View key={k} className={cell} style={{ width: COL[i] }}>
                      <Text
                        className="text-[12.5px] leading-[20px] text-muk-soft"
                        weight="extrabold"
                        numberOfLines={1}
                        accessibilityRole="header"
                        style={{ letterSpacing: 0.25 }}
                      >
                        {t(`dataTab.${k}`)}
                      </Text>
                    </View>
                  ))}
                </View>
                {ROWS.map((row, r) => {
                  const last = r === ROWS.length - 1;
                  const c = last ? 'px-[14px] py-[12px]' : cell;
                  return (
                    <View key={`${row.org}-${row.api}`} className="flex-row">
                      <View className={c} style={{ width: COL[0] }}>
                        <Text className="text-[13px] leading-[20.8px] text-muk" weight="bold" numberOfLines={1}>
                          {t(`dataTab.${row.org}`)}
                        </Text>
                      </View>
                      <View className={c} style={{ width: COL[1] }}>
                        <Text className="text-[13px] leading-[20.8px] text-muk-soft">{t(`dataTab.${row.api}`)}</Text>
                        <Text className="mt-[5px] text-[12px] leading-[19.2px] text-gold-deep" style={{ fontFamily: MONO }}>
                          {row.ops}
                        </Text>
                      </View>
                      <View className={c} style={{ width: COL[2] }}>
                        <Text className="text-[13px] leading-[20.8px] text-muk-soft">{t(`dataTab.${row.screen}`)}</Text>
                      </View>
                      <View className={c} style={{ width: COL[3] }}>
                        <Text className="text-[13px] leading-[20.8px] text-muk-soft" numberOfLines={1}>
                          {t(`dataTab.${row.cycle}`)}
                        </Text>
                      </View>
                    </View>
                  );
                })}
              </View>
            </ScrollView>
          </View>

          <View className="mt-[22px] rounded-[15px] border border-line bg-hanji-deep p-[18px]" accessibilityLiveRegion="polite">
            <Text className="text-[14px] leading-[21px] text-muk" weight="extrabold">
              {t('dataTab.freshTitle')}
            </Text>
            {relative ? (
              <>
                <Text className="mt-[10px] text-[16px] leading-[24px] text-muk" weight="bold">
                  {t('dataTab.freshLabel')} <Text className="text-gold-deep">{relative}</Text>
                </Text>
                <Text className="mt-[8px] text-[13px] leading-[22.1px] text-muk-soft">
                  {freshness && freshness.source === 'estimate' ? t('dataTab.freshSourceEstimate') : t('dataTab.freshSourceEvent')}
                  {freshness && typeof freshness.written === 'number' ? ` · ${t('dataTab.freshWritten', { n: freshness.written })}` : ''}
                </Text>
              </>
            ) : (
              <Text className="mt-[8px] text-[13px] leading-[22.1px] text-muk-soft">
                {freshness === null ? t('dataTab.freshLoading') : t('dataTab.freshFallback')}
              </Text>
            )}
          </View>

          <Text className="mt-[22px] text-[13px] leading-[22.1px] text-muk-soft">{t('dataTab.note')}</Text>
        </View>
      )}
    </View>
  );
}
