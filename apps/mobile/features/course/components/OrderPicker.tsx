// 순서 지정 피커 — 웹 course/page.tsx 의 OrderPicker. 종류를 순서대로 담으면 그 순서대로 코스를 배정한다(body.sequence).
// 웹의 framer Reorder 대신 react-native-draggable-flatlist(가로, 길게 눌러 끌기). 보이는 '앞으로 · 뒤로' 줄은 웹에 없어 지웠다(결정 D21/E7 — 웹에 맞춘다).
// 끌기 대안은 칩의 스크린리더 사용자 지정 동작(앞으로·뒤로·빼기)으로 남는다. 손으로는 ✕ 로 빼고 다시 담아 순서를 바꾼다.
// sequence 가 1개 이상이면 '순서 모드' — 아래 종류 필터(자동 모드용)는 그리지 않는다(두 입력이 동시에 보이면 어느 쪽이 적용되는지 헷갈린다).
import { X } from 'lucide-react-native';
import { Platform } from 'react-native';
import { View } from 'react-native';
import DraggableFlatList, { ScaleDecorator, type RenderItemParams } from 'react-native-draggable-flatlist';

import { Chip, Icon, Pressable, Text } from '~/components/ui';
import { useT } from '~/lib/i18n/I18nProvider';
import { haptic } from '~/lib/platform/haptics';

import { typeEmoji } from '../model';
import { MAX_SEQUENCE, TYPE_OPTIONS, type SequenceItem } from '../types';

/** 웹 <h2> — 웹 빌드에서만 제목 단계를 붙인다. */
const HEADING_LEVEL_2 = (Platform.OS === 'web' ? { 'aria-level': 2 } : {}) as object;

export function OrderPicker({
  sequence,
  onAdd,
  onRemove,
  onReorder,
  onMove,
  onReset,
  selectedTypes,
  onToggleType,
}: {
  sequence: SequenceItem[];
  onAdd: (type: string) => void;
  onRemove: (uid: string) => void;
  onReorder: (next: SequenceItem[]) => void;
  onMove: (from: number, to: number) => void;
  onReset: () => void;
  selectedTypes: string[];
  onToggleType: (id: string) => void;
}) {
  const t = useT();
  const full = sequence.length >= MAX_SEQUENCE;

  const renderItem = ({ item, drag, isActive, getIndex }: RenderItemParams<SequenceItem>) => {
    const idx = getIndex() ?? 0;
    const label = t(`category.${item.type}`);
    return (
      <ScaleDecorator>
        <Pressable
          onLongPress={() => {
            haptic('selection');
            drag();
          }}
          delayLongPress={180}
          disabled={isActive}
          accessibilityRole="adjustable"
          accessibilityLabel={`${idx + 1}. ${label}`}
          accessibilityHint={t('app.course.reorderHint')}
          accessibilityActions={[
            { name: 'decrement', label: t('app.course.moveEarlier', { type: label }) },
            { name: 'increment', label: t('app.course.moveLater', { type: label }) },
            { name: 'delete', label: t('course.orderRemoveAria', { type: label }) },
          ]}
          onAccessibilityAction={(e) => {
            if (e.nativeEvent.actionName === 'decrement') onMove(idx, idx - 1);
            else if (e.nativeEvent.actionName === 'increment') onMove(idx, idx + 1);
            else if (e.nativeEvent.actionName === 'delete') onRemove(item.uid);
          }}
          className="mr-[8px] min-h-[44px] flex-row items-center gap-[6px] rounded-full border border-gold/40 bg-gold/15 pl-[12px] pr-[6px]"
          style={{ boxShadow: '0px 1px 4px rgba(193, 154, 62, 0.18)' }}
        >
          <Text className="text-[13px] text-gold-deep/70" weight="bold">
            {idx + 1}
          </Text>
          <Text className="text-[13px] text-gold-deep" weight="bold" numberOfLines={1}>
            {typeEmoji(item.type)} {label}
          </Text>
          <Pressable
            onPress={() => onRemove(item.uid)}
            accessibilityRole="button"
            accessibilityLabel={t('course.orderRemoveAria', { type: label })}
            hitSlop={6}
            className="h-[32px] w-[32px] items-center justify-center rounded-full"
          >
            <Icon icon={X} size="sm" color="gold-deep" />
          </Pressable>
        </Pressable>
      </ScaleDecorator>
    );
  };

  return (
    <View className="gap-[12px] rounded-2xl border border-line/70 bg-hanji-deep/35 p-[16px]">
      <View className="gap-[4px]">
        <Text className="text-[15px] leading-[18.75px]" weight="bold" accessibilityRole="header" {...HEADING_LEVEL_2}>
          {t('course.orderTitle')}
        </Text>
        <Text className="text-[11px] leading-[17.9px] text-muk-soft">{t('course.orderHint')}</Text>
      </View>

      <View className="flex-row flex-wrap gap-[8px]">
        {TYPE_OPTIONS.map((opt) => (
          <Chip
            key={opt.id}
            variant="courseType"
            label={t(`category.${opt.id}`)}
            emoji={opt.emoji}
            disabled={full}
            accessibilityLabel={t('course.orderAddAria', { type: t(`category.${opt.id}`) })}
            onPress={() => onAdd(opt.id)}
          />
        ))}
      </View>

      {sequence.length > 0 && (
        <View className="gap-[10px]">
          <DraggableFlatList
            horizontal
            data={sequence}
            keyExtractor={(item) => item.uid}
            onDragEnd={({ data }) => onReorder(data)}
            renderItem={renderItem}
            activationDistance={8}
            showsHorizontalScrollIndicator={false}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('course.orderReset')}
            onPress={onReset}
            className="min-h-[44px] self-start justify-center rounded-full border border-line bg-white px-[16px]"
          >
            <Text className="text-[11px] leading-[16.5px] text-muk-soft" weight="bold">
              {t('course.orderReset')}
            </Text>
          </Pressable>
        </View>
      )}

      {sequence.length === 0 && (
        <View className="gap-[8px] border-t border-line/70 pt-[12px]">
          <View className="gap-[2px]">
            <Text className="text-[14px] leading-[17.5px]" weight="bold" accessibilityRole="header" {...HEADING_LEVEL_2}>
              {t('course.pickTitle')}
            </Text>
            <Text className="text-[11px] leading-[16.5px] text-muk-soft" weight="semibold">
              {t('course.typeFilterLabel')}
            </Text>
          </View>
          <View className="flex-row flex-wrap gap-[8px]">
            {TYPE_OPTIONS.map((opt) => (
              <Chip
                key={opt.id}
                variant="courseType"
                label={t(`category.${opt.id}`)}
                emoji={opt.emoji}
                selected={selectedTypes.includes(opt.id)}
                onPress={() => onToggleType(opt.id)}
              />
            ))}
          </View>
        </View>
      )}
    </View>
  );
}
