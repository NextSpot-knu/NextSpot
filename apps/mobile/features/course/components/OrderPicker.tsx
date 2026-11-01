// 순서 지정 피커 — 웹 course/page.tsx 의 OrderPicker. 종류를 순서대로 담으면 그 순서대로 코스를 배정한다(body.sequence).
// 웹의 framer Reorder 대신 react-native-draggable-flatlist(가로, 길게 눌러 끌기). 끌기는 손가락 전용이라
// 같은 일을 하는 '앞으로 · 뒤로' 버튼(44pt)과 스크린리더 사용자 지정 동작을 함께 둔다(접근성 대안).
// sequence 가 1개 이상이면 '순서 모드' — 아래 종류 필터(자동 모드용)는 그리지 않는다(두 입력이 동시에 보이면 어느 쪽이 적용되는지 헷갈린다).
import { ChevronLeft, ChevronRight, X } from 'lucide-react-native';
import { View } from 'react-native';
import DraggableFlatList, { ScaleDecorator, type RenderItemParams } from 'react-native-draggable-flatlist';

import { Chip, Icon, Pressable, Text } from '~/components/ui';
import { useT } from '~/lib/i18n/I18nProvider';
import { haptic } from '~/lib/platform/haptics';

import { typeEmoji } from '../model';
import { MAX_SEQUENCE, TYPE_OPTIONS, type SequenceItem } from '../types';

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
        <Text className="text-[15px]" weight="bold">
          {t('course.orderTitle')}
        </Text>
        <Text className="text-[12px] leading-[18px] text-muk-soft">{t('course.orderHint')}</Text>
      </View>

      <View className="flex-row flex-wrap gap-[8px]">
        {TYPE_OPTIONS.map((opt) => (
          <Chip
            key={opt.id}
            label={t(`category.${opt.id}`)}
            emoji={opt.emoji}
            disabled={full}
            accessibilityLabel={t('course.orderAddAria', { type: t(`category.${opt.id}`) })}
            onPress={() => onAdd(opt.id)}
            className="min-h-[44px] px-[16px]"
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
          {/* 앞·뒤 버튼 — 끌기를 못 쓰는 사람과 스크린리더용. 칸마다 한 쌍(이름으로 어느 칸인지 구분). */}
          <View className="gap-[6px]">
            {sequence.map((item, idx) => {
              const label = t(`category.${item.type}`);
              return (
                <View key={item.uid} className="min-h-[44px] flex-row items-center gap-[8px]">
                  <Text className="min-w-0 flex-1 text-[13px]" weight="semibold" numberOfLines={1}>
                    {idx + 1}. {typeEmoji(item.type)} {label}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('app.course.moveEarlier', { type: label })}
                    accessibilityState={{ disabled: idx === 0 }}
                    disabled={idx === 0}
                    onPress={() => onMove(idx, idx - 1)}
                    className={`h-[44px] w-[44px] items-center justify-center rounded-full border border-line bg-white ${idx === 0 ? 'opacity-40' : ''}`}
                  >
                    <Icon icon={ChevronLeft} size="md" color="muk-soft" />
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('app.course.moveLater', { type: label })}
                    accessibilityState={{ disabled: idx === sequence.length - 1 }}
                    disabled={idx === sequence.length - 1}
                    onPress={() => onMove(idx, idx + 1)}
                    className={`h-[44px] w-[44px] items-center justify-center rounded-full border border-line bg-white ${idx === sequence.length - 1 ? 'opacity-40' : ''}`}
                  >
                    <Icon icon={ChevronRight} size="md" color="muk-soft" />
                  </Pressable>
                </View>
              );
            })}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('course.orderReset')}
            onPress={onReset}
            className="min-h-[44px] self-start justify-center rounded-full border border-line bg-white px-[16px]"
          >
            <Text className="text-[12px] text-muk-soft" weight="bold">
              {t('course.orderReset')}
            </Text>
          </Pressable>
        </View>
      )}

      {sequence.length === 0 && (
        <View className="gap-[8px] border-t border-line/70 pt-[12px]">
          <View className="gap-[2px]">
            <Text className="text-[14px]" weight="bold">
              {t('course.pickTitle')}
            </Text>
            <Text className="text-[12px] text-muk-soft" weight="semibold">
              {t('course.typeFilterLabel')}
            </Text>
          </View>
          <View className="flex-row flex-wrap gap-[8px]">
            {TYPE_OPTIONS.map((opt) => (
              <Chip
                key={opt.id}
                label={t(`category.${opt.id}`)}
                emoji={opt.emoji}
                selected={selectedTypes.includes(opt.id)}
                onPress={() => onToggleType(opt.id)}
                className="min-h-[44px] px-[16px]"
              />
            ))}
          </View>
        </View>
      )}
    </View>
  );
}
