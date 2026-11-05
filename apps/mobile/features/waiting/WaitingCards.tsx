// 대기 보드의 대표 카드(세로로 긴 포트레이트)와 컴팩트 행 — 웹 waiting/page.tsx 의 WaitStats · WaitRowChips · 카드·행.
// 세 숫자(예상 대기 · 혼잡 등급 · 한산해지는 시각)를 카드와 행이 **같은 순서로** 보여 준다.
// 앱 v1 은 알림이 없다(계획 §3.1): 한산해지는 시각은 글자로만 말하고 알림 예약 버튼은 없다.
import { ChevronRight } from 'lucide-react-native';
import { View } from 'react-native';

import { Icon, Pressable, Text } from '~/components/ui';
import { useBusyThreshold } from '~/lib/core/publicSettings';
import { useI18n } from '~/lib/i18n/I18nProvider';
import { splitHeadlineValue } from '@/lib/headlineSplit';
import { areaDemandDisclosure } from '@/lib/areaDemandPresentation';
import { calmAfterClose, displayArrivalTime, showsCalmLine, type WaitEstimate } from '@/lib/waitEstimate';

import type { BoardRow } from './boardData';
import { PlaceTile } from './PlaceTile';
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

/** 대표 카드의 세 숫자 블록. */
function WaitStats({ est, row, estimateLevel, display = PLAIN_DISPLAY }: StatProps) {
  const { t, locale } = useI18n();
  const busyAt = useBusyThreshold();
  const h = headlineOf(est, row, estimateLevel, busyAt);
  const headline = display.walk ? walkText(row, t) : headlineText(h, t);
  const tone: Tone = display.walk ? { box: 'bg-jade/10 border-jade/30', text: 'text-jade' } : headlineTone(h, est);
  const showGrade = est.grade !== null && est.minutes !== null && est.minutes > 0;
  const showCalm = !display.hideCalm && !calmAfterClose(est, row.operatingHours) && showsCalmLine(est);
  return (
    <View className="mt-[6px] gap-[4px]">
      {headline !== null ? (
        <View className={`rounded-lg border px-[8px] py-[4px] ${toneBox(tone)}`}>
          <Text className={`text-[13px] leading-[18px] ${tone.text}`} weight="extrabold">
            <HeadlineText text={headline} locale={locale} />
          </Text>
        </View>
      ) : null}
      <View className="flex-row flex-wrap items-center gap-[4px]">
        {showGrade ? (
          <View className={`rounded-md border px-[6px] py-[2px] ${toneBox(gradeTone(est.grade!))}`}>
            <Text className={`text-[11px] ${gradeTone(est.grade!).text}`} weight="bold">
              {t(`wait.grade.${est.grade}`)}
            </Text>
          </View>
        ) : null}
        {est.estimated ? (
          <View className="rounded-md border border-line bg-muk/5 px-[6px] py-[2px]">
            <Text className="text-[11px] text-muk-soft" weight="bold">
              {t('wait.estimatedTag')}
            </Text>
          </View>
        ) : null}
        {row.closedToday ? (
          <View className="rounded-md border border-terracotta/30 bg-terracotta/10 px-[6px] py-[2px]">
            <Text className="text-[11px] text-terracotta" weight="bold">
              {t('card.closedToday')}
            </Text>
          </View>
        ) : null}
      </View>
      {showCalm ? (
        <Text className="text-[11px] leading-[15px] text-jade" weight="bold">
          {est.calmHour === null ? t('wait.calmNow') : t('wait.calmAt', { h: est.calmHour })}
        </Text>
      ) : null}
      <Text className="text-[11px] leading-[15px] text-muk-soft">
        {arrivalLine(est, display, displayArrivalTime(est.arrivalHour), t)}
      </Text>
    </View>
  );
}

export interface WaitingCardProps extends StatProps {
  index: number;
  count: number;
  onPress: () => void;
  /** 카드 폭(pt). 캐러셀은 화면 폭의 80%, 격자는 칸 폭. */
  width?: number;
}

/** 대표 카드. 누르면 이 장소 둘레의 같은 종류 대안(/explore/recommend). */
export function WaitingCard({ est, row, estimateLevel, display, index, count, onPress, width }: WaitingCardProps) {
  const { t } = useI18n();
  const first = index === 0;
  const busyAt = useBusyThreshold();
  const h = headlineOf(est, row, estimateLevel, busyAt);
  const headline = display?.walk ? walkText(row, t) : headlineText(h, t);
  // 읽기: '2 / 3 · 이름 · 대기 줄' — 몇 번째 카드인지 먼저 알린다.
  const label = [`${index + 1} / ${count}`, row.name, headline, t('waiting.seeInstead')].filter(Boolean).join(', ');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className={`min-h-[316px] overflow-hidden rounded-2xl border ${first ? 'border-gold/40 bg-gold/10' : 'border-line bg-white'}`}
      style={width ? { width } : { flex: 1 }}
    >
      <View
        className={`absolute left-[6px] top-[6px] z-10 h-[28px] w-[28px] items-center justify-center rounded-full border-2 border-white ${first ? 'bg-gold-deep' : 'bg-gold'}`}
        accessibilityElementsHidden
        importantForAccessibility="no"
      >
        <Text className="text-[13px] text-white" weight="extrabold">
          {index + 1}
        </Text>
      </View>
      <PlaceTile
        facilityId={row.facilityId}
        type={row.type}
        urls={row.imageUrls}
        className="w-full border-b border-line"
        style={{ height: 112 }}
      />
      <View className="flex-1 justify-between p-[8px]">
        <View>
          <Text className="text-[13px] leading-[17px]" weight="bold" numberOfLines={2}>
            {row.name}
          </Text>
          {row.menus.length > 0 ? (
            <Text className="mt-[2px] text-[11px] leading-[15px] text-gold-deep" weight="bold" numberOfLines={2}>
              {`🍽 ${row.menus.join(' · ')}`}
            </Text>
          ) : null}
          {row.summary ? (
            <Text className="mt-[4px] text-[11px] leading-[15px] text-muk-soft" numberOfLines={2}>
              {row.summary}
            </Text>
          ) : null}
        </View>
        <WaitStats est={est} row={row} estimateLevel={estimateLevel} display={display} />
      </View>
      <View className="min-h-[36px] flex-row items-center justify-center gap-[2px] border-t border-line/70 px-[4px] py-[6px]">
        <Text className="text-center text-[12px] leading-[16px] text-gold-deep" weight="bold">
          {t('waiting.seeInstead')}
        </Text>
        <Icon icon={ChevronRight} size="sm" color="gold-deep" />
      </View>
    </Pressable>
  );
}

/** 컴팩트 행의 세 숫자 — 같은 값을 칩 한 줄로 압축한다. */
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
          <Text className={`text-[12px] ${tone.text}`} weight="bold">
            {headline}
          </Text>
        </View>
      ) : null}
      {est.grade !== null && est.minutes !== null && est.minutes > 0 ? (
        <View className={`rounded-md border px-[8px] py-[4px] ${toneBox(gradeTone(est.grade))}`}>
          <Text className={`text-[12px] ${gradeTone(est.grade).text}`} weight="bold">
            {t(`wait.grade.${est.grade}`)}
          </Text>
        </View>
      ) : null}
      {!display.hideCalm && !calmAfterClose(est, row.operatingHours) && showsCalmLine(est) ? (
        <Text className="text-[12px] text-jade" weight="bold">
          {est.calmHour === null ? t('wait.calmNow') : t('wait.calmAt', { h: est.calmHour })}
        </Text>
      ) : null}
      {est.estimated ? (
        <Text className="text-[12px] text-muk-soft" weight="semibold">
          {t('wait.estimatedTag')}
        </Text>
      ) : null}
      {row.closedToday ? (
        <View className="rounded-md border border-terracotta/30 bg-terracotta/10 px-[8px] py-[4px]">
          <Text className="text-[12px] text-terracotta" weight="bold">
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
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[row.name, headline, t('waiting.seeInstead')].filter(Boolean).join(', ')}
      onPress={onPress}
      className="min-h-[44px] flex-row items-center gap-[12px] rounded-2xl border border-line bg-white px-[14px] py-[12px]"
    >
      <PlaceTile
        facilityId={row.facilityId}
        type={row.type}
        urls={row.imageUrls}
        glyphSize={20}
        className="h-[48px] w-[48px] rounded-xl border border-line"
      />
      <View className="min-w-0 flex-1">
        <Text className="text-[15px] leading-[20px]" weight="bold" numberOfLines={1}>
          {row.name}
        </Text>
        <WaitRowChips est={est} row={row} estimateLevel={estimateLevel} display={display} />
        {showDeparture ? (
          <Text className="mt-[4px] text-[11px] text-sky-800" weight="bold">
            {t(`recommend.arrivalAction.${row.arrivalAction}`, { n: row.recommendedDepartureDelayMinutes ?? 30 })}
          </Text>
        ) : null}
      </View>
      <Icon icon={ChevronRight} size="lg" color="muk-soft" />
    </Pressable>
  );
}
