// 한 유형의 게시판 한 판 — 섹터 머리 + 대표 카드 3장 + 컴팩트 행. 웹 waiting/page.tsx 의 섹터 section.
// 대표 카드 3장: 폭이 좁으면(폰) 가로로 넘기는 한 줄(화면의 80% 폭 + 스냅 + 점), 넓으면(펼친 폴더블) 세 칸 격자.
// 점(SwipeDots)은 몇 번째인지 보여 주고, 스크린 리더에는 '2 / 3' 을 읽어 주며 위·아래 쓸기(increment/decrement)로 넘긴다.
import { useCallback, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  FlatList,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import { Text } from '~/components/ui';
import { useBusyThreshold } from '~/lib/core/publicSettings';
import { countKey, useT } from '~/lib/i18n/I18nProvider';

import { TYPE_EMOJI, type BoardRow, type Sector } from './boardData';
import { splitSector, type WaitOf } from './boardView';
import { GoldenHourLabel } from './GoldenHourLabel';
import type { CardDisplay } from './presentation';
import { activeIndexFromOffset, positionLabel } from './presentation';
import { WaitingCard, WaitingRow } from './WaitingCards';

/** 이 폭(pt) 이상이면 대표 카드를 세 칸 격자로(웹 sm:grid-cols-3 에 해당). */
export const GRID_MIN_WIDTH = 520;
const GAP = 8;

export interface SectorBoardProps {
  sector: Sector;
  waitOf: WaitOf;
  estimateLevels: Record<string, number>;
  displayOf: (row: BoardRow) => CardDisplay;
  /** 다 찬 보드에서만 골든타임을 단다(부분 섹션에 달면 순차 조회와 겹친다). */
  committed: boolean;
  onOpen: (row: BoardRow) => void;
}

function SwipeDots({
  count,
  active,
  label,
  onStep,
}: {
  count: number;
  active: number;
  label: string;
  onStep: (delta: 1 | -1) => void;
}) {
  return (
    <View
      className="mt-[8px] min-h-[24px] flex-row items-center justify-center gap-[6px]"
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ min: 1, max: count, now: active + 1, text: positionLabel(active, count) }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => onStep(e.nativeEvent.actionName === 'increment' ? 1 : -1)}
    >
      {Array.from({ length: count }, (_, i) => (
        <View key={i} className={`h-[6px] rounded-full ${i === active ? 'w-[16px] bg-gold' : 'w-[6px] bg-line'}`} />
      ))}
    </View>
  );
}

export function SectorBoard({ sector, waitOf, estimateLevels, displayOf, committed, onOpen }: SectorBoardProps) {
  const t = useT();
  const busyAt = useBusyThreshold();
  const { topRows, restRows } = splitSector(sector, waitOf, estimateLevels, busyAt);
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState(0);
  const listRef = useRef<FlatList<BoardRow>>(null);
  const activeRef = useRef(0);

  const onLayout = useCallback((e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width)), []);
  const carousel = topRows.length >= 3 && width > 0 && width < GRID_MIN_WIDTH;
  const cardWidth = Math.round(width * 0.8);
  const step = cardWidth + GAP;

  const settle = useCallback(
    (index: number) => {
      if (index === activeRef.current) return;
      activeRef.current = index;
      setActive(index);
      AccessibilityInfo.announceForAccessibility(positionLabel(index, topRows.length));
    },
    [topRows.length],
  );
  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const index = activeIndexFromOffset(e.nativeEvent.contentOffset.x, step, topRows.length);
      if (index !== activeRef.current) {
        activeRef.current = index;
        setActive(index);
      }
    },
    [step, topRows.length],
  );
  const onStep = useCallback(
    (delta: 1 | -1) => {
      const next = Math.min(topRows.length - 1, Math.max(0, activeRef.current + delta));
      listRef.current?.scrollToOffset({ offset: next * step, animated: true });
      settle(next);
    },
    [settle, step, topRows.length],
  );

  const sectorName = t(`category.${sector.type}`);
  const card = (row: BoardRow, idx: number, w?: number) => (
    <WaitingCard
      key={row.facilityId}
      est={waitOf(row)}
      row={row}
      estimateLevel={estimateLevels[row.facilityId]}
      display={displayOf(row)}
      index={idx}
      count={topRows.length}
      onPress={() => onOpen(row)}
      width={w}
    />
  );

  return (
    <View className="rounded-3xl border border-line/70 bg-white/60 p-[12px]">
      <View className="mb-[10px] flex-row items-center gap-[8px]">
        <View
          className="h-[32px] w-[32px] items-center justify-center rounded-xl border border-gold/25 bg-gold/10"
          accessibilityElementsHidden
          importantForAccessibility="no"
        >
          <Text className="text-[16px]">{TYPE_EMOJI[sector.type] ?? '📍'}</Text>
        </View>
        <Text className="flex-1 text-[15px]" weight="bold" accessibilityRole="header">
          {sectorName}
        </Text>
        <View className="rounded-full bg-hanji-deep px-[10px] py-[4px]">
          <Text className="text-[11px] text-muk-soft" weight="bold">
            {t(countKey('waiting.sectorCount', sector.rows.length), { n: sector.rows.length })}
          </Text>
        </View>
      </View>

      <View onLayout={onLayout}>
        {width === 0 ? (
          // 폭을 재기 전에는 자리만 — 격자로 한 번 그렸다가 캐러셀로 바뀌는 깜빡임을 막는다.
          <View style={{ minHeight: 316 }} />
        ) : carousel ? (
          <FlatList
            ref={listRef}
            horizontal
            data={topRows}
            keyExtractor={(r) => r.facilityId}
            renderItem={({ item, index }) => card(item, index, cardWidth)}
            ItemSeparatorComponent={() => <View style={{ width: GAP }} />}
            showsHorizontalScrollIndicator={false}
            snapToInterval={step}
            snapToAlignment="start"
            decelerationRate="fast"
            scrollEventThrottle={16}
            onScroll={onScroll}
            onMomentumScrollEnd={(e) =>
              settle(activeIndexFromOffset(e.nativeEvent.contentOffset.x, step, topRows.length))
            }
            // 카드 안 이모지·글자가 늦게 바뀌어도 줄 높이가 같게 — 가장 긴 카드에 맞춘다(웹 items-stretch).
            contentContainerStyle={{ alignItems: 'stretch' }}
          />
        ) : (
          <View className="flex-row items-stretch" style={{ gap: GAP }}>
            {topRows.map((row, idx) => card(row, idx))}
          </View>
        )}
      </View>
      {carousel ? <SwipeDots count={topRows.length} active={active} label={sectorName} onStep={onStep} /> : null}

      {committed && topRows[0] ? <GoldenHourLabel facilityId={topRows[0].facilityId} className="mt-[8px]" /> : null}

      {restRows.length > 0 ? (
        <View className="mt-[10px] gap-[8px]">
          {restRows.map((row) => (
            <WaitingRow
              key={row.facilityId}
              est={waitOf(row)}
              row={row}
              estimateLevel={estimateLevels[row.facilityId]}
              display={displayOf(row)}
              onPress={() => onOpen(row)}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}
