// 대기 보드의 대표 카드(세로로 긴 포트레이트)와 컴팩트 행 — 웹 waiting/page.tsx 의 WaitStats · WaitRowChips · CardIntro · 카드·행.
// 세 숫자(예상 대기 · 혼잡 등급 · 한산해지는 시각)를 카드와 행이 **같은 순서로** 보여 준다.
// 알림 버튼('알림 받기')은 이 파일이 아니라 골든타임 배지(F1)가 맡는다.
import { ChevronRight } from 'lucide-react-native';
import { useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';

import { Icon, Pressable, Text } from '~/components/ui';
import { CreditLine } from '~/components/ui/CreditLine';
import { RankBadge } from '~/components/ui/RankBadge';
import { creditForDisplayedPhoto, creditedPhotoUrls, isCityPhotoUrl, isWikimediaUrl } from '~/features/explore/port/photoCredit';
import { useBusyThreshold } from '~/lib/core/publicSettings';
import { useI18n } from '~/lib/i18n/I18nProvider';
import { shadows } from '~/lib/theme/tokens';
import { splitHeadlineValue } from '@/lib/headlineSplit';
import { areaDemandDisclosure } from '@/lib/areaDemandPresentation';
import { placeVisual, type PlaceVisual } from '@/lib/placeVisual';
import { calmAfterClose, displayArrivalTime, showsCalmLine, type WaitEstimate } from '@/lib/waitEstimate';
import { fitWholeLines } from '@/lib/wholeLines';

import type { BoardRow } from './boardData';
import { rowPhotoFeatures } from './boardView';
import { PlaceTile, usePhotoCursor } from './PlaceTile';
import {
  PLAIN_DISPLAY,
  arrivalLine,
  gradeTone,
  headlineOf,
  headlineText,
  headlineTone,
  walkText,
  type CardDisplay,
  type Tone,
} from './presentation';

interface StatProps {
  est: WaitEstimate;
  row: BoardRow;
  estimateLevel?: number;
  display?: CardDisplay;
}

function toneBox(tone: Tone): string {
  return `${tone.box}${tone.dashed ? ' border-dashed' : ''}`;
}

/** 한국어가 아닌 머리줄은 값(쌍점 뒤·숫자+단위)을 한 덩어리로 둔다 — 좁은 카드에서 값 한가운데서 접히지 않게(웹 HeadlineText). */
function HeadlineText({ text, locale }: { text: string; locale: string }) {
  if (locale === 'ko') return <>{text}</>;
  const parts = splitHeadlineValue(text);
  if (!parts || !parts[1]) return <>{text}</>;
  return (
    <>
      {parts[0]}
      {/* RN 에는 whitespace-nowrap 이 없다 — 값 안 공백을 줄바꿈 없는 공백으로 바꿔 한 덩어리로 둔다. */}
      <Text>{parts[1].replace(/ /g, ' ')}</Text>
      {parts[2]}
    </>
  );
}

/** 대표 카드의 세 숫자 블록(웹 글자: 머리줄 12/16.5 extrabold · 칩 10/15 · 한산 줄 10/13.75 · 근거 줄 11/15.1). */
function WaitStats({ est, row, estimateLevel, display = PLAIN_DISPLAY }: StatProps) {
  const { t, locale } = useI18n();
  const busyAt = useBusyThreshold();
  const h = headlineOf(est, row, estimateLevel, busyAt);
  const headline = display.walk ? walkText(row, t) : headlineText(h, t);
  const tone: Tone = display.walk ? { box: 'bg-jade/10 border-jade/30', text: 'text-jade' } : headlineTone(h, est);
  const showGrade = est.grade !== null && est.minutes !== null && est.minutes > 0;
  const showCalm = !display.hideCalm && !calmAfterClose(est, row.operatingHours) && showsCalmLine(est);
  return (
    <View className="mt-[6px] gap-[4px]" style={{ flexShrink: 0 }}>
      {headline !== null ? (
        <View className={`rounded-lg border px-[8px] py-[4px] ${toneBox(tone)}`}>
          <Text className={`text-[12px] leading-[16.5px] ${tone.text}`} weight="extrabold">
            <HeadlineText text={headline} locale={locale} />
          </Text>
        </View>
      ) : null}
      <View className="flex-row flex-wrap items-center gap-[4px]">
        {showGrade ? (
          <View className={`rounded-md border px-[6px] py-[2px] ${toneBox(gradeTone(est.grade!))}`}>
            <Text className={`text-[10px] leading-[15px] ${gradeTone(est.grade!).text}`} weight="bold">
              {t(`wait.grade.${est.grade}`)}
            </Text>
          </View>
        ) : null}
        {est.estimated ? (
          <View className="rounded-md border border-line bg-muk/5 px-[6px] py-[2px]">
            <Text className="text-[10px] leading-[15px] text-muk-soft" weight="bold">
              {t('wait.estimatedTag')}
            </Text>
          </View>
        ) : null}
        {row.closedToday ? (
          <View className="rounded-md border border-terracotta/30 bg-terracotta/10 px-[6px] py-[2px]">
            <Text className="text-[10px] leading-[15px] text-terracotta" weight="bold">
              {t('card.closedToday')}
            </Text>
          </View>
        ) : null}
      </View>
      {showCalm ? (
        <Text className="text-[10px] leading-[13.75px] text-jade" weight="bold">
          {est.calmHour === null ? t('wait.calmNow') : t('wait.calmAt', { h: est.calmHour })}
        </Text>
      ) : null}
      <Text className="text-[11px] leading-[15.125px] text-muk-soft">
        {arrivalLine(est, display, displayArrivalTime(est.arrivalHour), t)}
      </Text>
    </View>
  );
}

// ── 카드 소개 블록 — 남는 자리에 **온전한 줄만** 싣는다(G5a-11, 웹 CardIntro + fitWholeLines) ──────────────────────
// 소개 블록은 flexBasis 0 으로 자라기만 해서 글 양이 카드 높이를 바꾸지 않는다(카드는 min 316). 보이지 않는 측정용 사본이
// 늘 2줄 상한으로 줄 수를 재고(react-native-web 은 onTextLayout 이 없어 높이 ÷ 줄 높이), 보이는 쪽은 fitWholeLines 결과로 자른다 —
// 자른 글의 onLayout 이 원래 줄 수를 덮어쓰지 않는다(R3).
const NAME_LH = 16.5;
const SMALL_LH = 13.75;
const NAME_CLASS = 'text-[12px] leading-[16.5px]';
const MENU_CLASS = 'text-[10px] leading-[13.75px] text-gold-deep';
const SUMMARY_CLASS = 'text-[10px] leading-[13.75px] text-muk-soft';

function CardIntro({ name, menus, summary }: { name: string; menus: string[]; summary: string | null }) {
  const menuText = menus.length > 0 ? `🍽 ${menus.join(' · ')}` : null;
  const [avail, setAvail] = useState<number | null>(null);
  const [heights, setHeights] = useState<{ name?: number; menu?: number; summary?: number }>({});
  const measure = (key: 'name' | 'menu' | 'summary') => (e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    setHeights((prev) => (prev[key] === h ? prev : { ...prev, [key]: h }));
  };

  const present: ('name' | 'menu' | 'summary')[] = ['name'];
  if (menuText) present.push('menu');
  if (summary) present.push('summary');
  const ready = avail !== null && present.every((k) => heights[k] !== undefined);
  const lineHeight = (k: 'name' | 'menu' | 'summary') => (k === 'name' ? NAME_LH : SMALL_LH);
  const gap = (k: 'name' | 'menu' | 'summary') => (k === 'menu' ? 2 : k === 'summary' ? 4 : 0);
  const shownCounts = ready
    ? fitWholeLines(
        avail!,
        present.map((k) => ({
          lineHeight: lineHeight(k),
          lines: Math.round((heights[k] ?? 0) / lineHeight(k)),
          gapBefore: gap(k),
        })),
      )
    : present.map(() => 2);
  const shown = (k: 'name' | 'menu' | 'summary') => shownCounts[present.indexOf(k)] ?? 0;

  return (
    <View
      style={{ flexGrow: 1, flexBasis: 0, minHeight: NAME_LH, overflow: 'hidden' }}
      onLayout={(e) => setAvail(Math.round(e.nativeEvent.layout.height * 100) / 100)}
    >
      {/* 측정용 사본 — 눈에 보이지 않고 읽히지 않는다. 늘 2줄 상한. */}
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ position: 'absolute', left: 0, right: 0, top: 0, opacity: 0 }}
      >
        <Text className={NAME_CLASS} weight="bold" numberOfLines={2} onLayout={measure('name')}>
          {name}
        </Text>
        {menuText ? (
          <Text className={MENU_CLASS} weight="bold" numberOfLines={2} onLayout={measure('menu')}>
            {menuText}
          </Text>
        ) : null}
        {summary ? (
          <Text className={SUMMARY_CLASS} numberOfLines={2} onLayout={measure('summary')}>
            {summary}
          </Text>
        ) : null}
      </View>
      {/* 보이는 쪽 — 잴 때까지는 숨겨 둔다(2줄로 그렸다가 줄어드는 깜빡임을 막는다). */}
      <View style={{ opacity: ready ? 1 : 0 }}>
        {shown('name') > 0 ? (
          <Text className={NAME_CLASS} weight="bold" numberOfLines={shown('name')}>
            {name}
          </Text>
        ) : null}
        {menuText && shown('menu') > 0 ? (
          <Text className={`mt-[2px] ${MENU_CLASS}`} weight="bold" numberOfLines={shown('menu')}>
            {menuText}
          </Text>
        ) : null}
        {summary && shown('summary') > 0 ? (
          <Text className={`mt-[4px] ${SUMMARY_CLASS}`} numberOfLines={shown('summary')}>
            {summary}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export interface WaitingCardProps extends StatProps {
  index: number;
  count: number;
  onPress: () => void;
  /** 카드 폭(pt). 캐러셀은 화면 폭의 80%, 격자는 칸 폭(없으면 flex 로 나눈다). */
  width?: number;
  /** 이 장소의 표지(한 줄 안에서 문양이 겹치지 않게 placeVisualsForRow 가 고른 것). */
  visual: PlaceVisual;
  /** 이 줄 카드 중 하나라도 출처가 붙는 사진을 띄울 수 있는가 — 출처 칸을 처음부터 잡아 아래가 밀리지 않게(웹 rowMayCredit). */
  rowMayCredit: boolean;
}

/** 대표 카드. 누르면 이 장소 둘레의 같은 종류 대안(/explore/recommend). */
export function WaitingCard({ est, row, estimateLevel, display, index, count, onPress, width, visual, rowMayCredit }: WaitingCardProps) {
  const { t } = useI18n();
  const first = index === 0;
  const busyAt = useBusyThreshold();
  const h = headlineOf(est, row, estimateLevel, busyAt);
  const headline = display?.walk ? walkText(row, t) : headlineText(h, t);
  // 읽기: '2 / 3 · 이름 · 대기 줄' — 몇 번째 카드인지 먼저 알린다.
  const label = [`${index + 1} / ${count}`, row.name, headline, t('waiting.seeInstead')].filter(Boolean).join(', ');

  // 출처 없는 Wikimedia 사진·짝 없는 경주시 사진은 후보에서 빠진다(출처 없이 띄우지 않는다).
  const features = rowPhotoFeatures(row);
  const photo = usePhotoCursor(creditedPhotoUrls(row.imageUrls, features));
  // 출처는 그 사진이 **보일 때만** — 받는 동안은 표지가 보이므로 출처도 없다.
  const credit = photo.loaded ? creditForDisplayedPhoto(photo.url, features) : null;

  return (
    <View style={[width ? { width } : { flex: 1, minWidth: 0 }, { scrollSnapAlign: 'start' } as object]}>
      {/* 바깥: 그림자(안드로이드 그림자가 안쪽 overflow 에 잘리지 않게) · 순위 원 자리 */}
      <View style={{ flex: 1, borderRadius: 16, boxShadow: shadows.card }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          onPress={onPress}
          className={`min-h-[316px] flex-1 overflow-hidden rounded-2xl border ${first ? 'border-gold/40 bg-gold/10' : 'border-line bg-white/90'}`}
        >
          <PlaceTile
            visual={visual}
            url={photo.url}
            loaded={photo.loaded}
            onLoaded={photo.onLoaded}
            onError={photo.onError}
            className="w-full border-b border-line"
            style={{ height: 112 }}
          />
          <View className="flex-1 p-[8px]">
            {/* 위 소개 블록은 남는 자리에 온전한 줄만 싣고, 아래 대기 스탯은 늘 온전히 남는다 — 카드의 주인공은 '도착 시 대기'다. */}
            <CardIntro name={row.name} menus={row.menus} summary={row.summary} />
            <WaitStats est={est} row={row} estimateLevel={estimateLevel} display={display} />
          </View>
          <View className="flex-row items-center justify-center gap-[2px] border-t border-line/70 px-[4px] py-[6px]">
            <Text className="text-center text-[11px] leading-[13.75px] text-gold-deep" weight="bold">
              {t('waiting.seeInstead')}
            </Text>
            <Icon icon={ChevronRight} size={13} color="gold-deep" />
          </View>
        </Pressable>
        <RankBadge rank={index + 1} size={28} style={{ position: 'absolute', top: 6, left: 6 }} />
      </View>
      {/* 높이를 늘 확보해 둔다 — 출처 줄이 생기고 사라져도 카드 줄이 흔들리지 않는다. 위 pt-2 는 카드 아래 가장자리를 누르려던 엄지가 새지 않게. */}
      <View className={rowMayCredit ? 'min-h-[36px] pt-[8px]' : 'min-h-[16px]'} style={{ minWidth: 0 }}>
        {credit ? <CreditLine credit={credit} stacked /> : null}
      </View>
    </View>
  );
}

/** 컴팩트 행의 세 숫자 — 같은 값을 칩 한 줄로 압축한다(웹 글자 11px, 칩 높이 26.5). */
function WaitRowChips({ est, row, estimateLevel, display = PLAIN_DISPLAY }: StatProps) {
  const { t } = useI18n();
  const busyAt = useBusyThreshold();
  const h = headlineOf(est, row, estimateLevel, busyAt);
  const headline = display.walk ? walkText(row, t) : headlineText(h, t);
  const tone: Tone = display.walk ? { box: 'bg-jade/10 border-jade/30', text: 'text-jade' } : headlineTone(h, est);
  return (
    <View className="mt-[4px] flex-row flex-wrap items-center gap-[6px]">
      {headline !== null ? (
        <View className={`rounded-md border px-[8px] py-[4px] ${toneBox(tone)}`}>
          <Text className={`text-[11px] leading-[16.5px] ${tone.text}`} weight="bold">
            {headline}
          </Text>
        </View>
      ) : null}
      {est.grade !== null && est.minutes !== null && est.minutes > 0 ? (
        <View className={`rounded-md border px-[8px] py-[4px] ${toneBox(gradeTone(est.grade))}`}>
          <Text className={`text-[11px] leading-[16.5px] ${gradeTone(est.grade).text}`} weight="bold">
            {t(`wait.grade.${est.grade}`)}
          </Text>
        </View>
      ) : null}
      {!display.hideCalm && !calmAfterClose(est, row.operatingHours) && showsCalmLine(est) ? (
        <Text className="text-[11px] text-jade" weight="bold">
          {est.calmHour === null ? t('wait.calmNow') : t('wait.calmAt', { h: est.calmHour })}
        </Text>
      ) : null}
      {est.estimated ? (
        <Text className="text-[11px] text-muk-soft" weight="semibold">
          {t('wait.estimatedTag')}
        </Text>
      ) : null}
      {row.closedToday ? (
        <View className="rounded-md border border-terracotta/30 bg-terracotta/10 px-[8px] py-[4px]">
          <Text className="text-[11px] leading-[16.5px] text-terracotta" weight="bold">
            {t('card.closedToday')}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export interface WaitingRowProps extends StatProps {
  onPress: () => void;
}

export function WaitingRow({ est, row, estimateLevel, display, onPress }: WaitingRowProps) {
  const { t } = useI18n();
  const busyAt = useBusyThreshold();
  const h = headlineOf(est, row, estimateLevel, busyAt);
  const headline = display?.walk ? walkText(row, t) : headlineText(h, t);
  const showDeparture =
    row.arrivalAction &&
    row.arrivalAction !== 'no_clear_advantage' &&
    areaDemandDisclosure(
      // 두 증거는 응답에서 그대로 넘어온다(주변 수요에 관광 지수가 섞이면 '덜 붐빈다'고 말하지 않는다).
      row.areaDemandParkingEvidence ?? null,
      row.areaDemandTourismEvidence,
    ).showQualitativeLevel;
  // 48px 사진 — 출처 줄을 달 자리가 없어 출처 표기가 필요 없는 사진(TourAPI 등)만. 없거나 깨지면 장소 표지.
  const photo = usePhotoCursor(row.imageUrls.filter((u) => !isWikimediaUrl(u) && !isCityPhotoUrl(u)));
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[row.name, headline, t('waiting.seeInstead')].filter(Boolean).join(', ')}
      onPress={onPress}
      className="min-h-[44px] flex-row items-center gap-[12px] rounded-2xl border border-line bg-white/90 px-[14px] py-[12px]"
      style={{ boxShadow: shadows.card }}
    >
      <PlaceTile
        visual={placeVisual(row.facilityId, row.type)}
        url={photo.url}
        loaded={photo.loaded}
        onLoaded={photo.onLoaded}
        onError={photo.onError}
        className="h-[48px] w-[48px] rounded-xl border border-line"
      />
      <View className="min-w-0 flex-1">
        <Text className="text-[15px] leading-[20.625px]" weight="bold" numberOfLines={1}>
          {row.name}
        </Text>
        <WaitRowChips est={est} row={row} estimateLevel={estimateLevel} display={display} />
        {showDeparture ? (
          <Text className="mt-[4px] text-[11px] text-sky-800" weight="bold">
            {t(`recommend.arrivalAction.${row.arrivalAction}`, { n: row.recommendedDepartureDelayMinutes ?? 30 })}
          </Text>
        ) : null}
      </View>
      <Icon icon={ChevronRight} size={18} color="rgba(107, 93, 79, 0.5)" />
    </Pressable>
  );
}
