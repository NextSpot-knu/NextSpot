import type { LucideIcon } from 'lucide-react-native';
import { View, type PressableProps as RNPressableProps } from 'react-native';

import { splitLegacyLayout } from './buttonSpec';
import { CHIP_SPECS, chipAccessibilityLabel, type ChipVariant } from './chipSpec';
import { cn } from './cn';
import { Icon } from './Icon';
import { Pressable } from './Pressable';
import { Text } from './Text';

export type { ChipVariant } from './chipSpec';

export type ChipProps = Omit<RNPressableProps, 'children' | 'style'> & {
  label: string;
  /**
   * 모양 묶음(웹 선택 모양이 화면마다 달라 variant 가 클래스를 통째로 바꿔 끼운다).
   * layer(기본·홈: 비취) · savedFilter(금 + muk medium + count) · courseType(금 + gold-deep bold + 그림자) · labReason(30pt, 선택 button-gold + 흰 글자).
   */
  variant?: ChipVariant;
  /** 켜짐 — 선택 모양은 variant 가 정한다. */
  selected?: boolean;
  icon?: LucideIcon;
  /** 이모지 등 글자 앞 덧붙임(웹 카테고리 칩의 🍽 처럼). */
  emoji?: string;
  /** 글자 뒤 개수 알약(savedFilter). 읽기 화면 이름은 "카페 1". */
  count?: number;
  disabled?: boolean;
  className?: string;
};

/**
 * 고를 수 있는 칩(필터·카테고리). 읽기 화면에 '선택됨' 상태를 알린다(웹 빌드는 Pressable 이 aria-pressed 로).
 * 줄 바꿈 배치는 부모에서 `flex-row flex-wrap gap-[6px]`. 높이·좌우 여백은 style — className 의 min-h-[…]·px-[…] 는 읽어서 옮긴다.
 */
export function Chip({
  label,
  variant = 'layer',
  selected = false,
  icon,
  emoji,
  count,
  disabled = false,
  className,
  accessibilityLabel,
  ...rest
}: ChipProps) {
  const spec = CHIP_SPECS[variant];
  const legacy = splitLegacyLayout(className);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={chipAccessibilityLabel(label, count, accessibilityLabel)}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      hitSlop={{ top: spec.hitSlopY, bottom: spec.hitSlopY, left: 0, right: 0 }}
      className={cn(
        'shrink-0 flex-row items-center rounded-full border',
        selected ? spec.selectedClass : spec.idleClass,
        disabled && spec.disabledClass,
        legacy.className,
      )}
      style={{
        minHeight: legacy.minHeight ?? spec.minHeight,
        paddingHorizontal: legacy.paddingX ?? spec.paddingX,
        paddingVertical: spec.paddingY,
        gap: spec.gap,
        boxShadow: selected ? spec.selectedShadow : undefined,
      }}
      {...rest}
    >
      {emoji ? <Text className="text-[13px]" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{emoji}</Text> : null}
      {icon ? <Icon icon={icon} size="sm" color={selected ? spec.selectedIcon : spec.idleIcon} /> : null}
      <Text
        className={cn(spec.labelClass, selected ? spec.selectedTextClass : spec.idleTextClass)}
        weight={spec.labelWeight}
        numberOfLines={1}
      >
        {label}
      </Text>
      {count !== undefined ? (
        <View
          className={cn('rounded-full px-[6px]', selected ? 'bg-gold/25' : 'bg-hanji-deep')}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Text className={cn('text-[11px]', selected ? 'text-gold-deep' : 'text-muk-soft')} weight="bold">
            {count}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}
