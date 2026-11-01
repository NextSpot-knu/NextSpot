import type { LucideIcon } from 'lucide-react-native';
import type { PressableProps as RNPressableProps } from 'react-native';

import { cn } from './cn';
import { Icon } from './Icon';
import { Pressable } from './Pressable';
import { Text } from './Text';

export type ChipProps = Omit<RNPressableProps, 'children' | 'style'> & {
  label: string;
  /** 켜짐 — 비취 테두리 + 비취 18% 바탕 + 먹 글자(웹 app/main/page.tsx layerChipClass). */
  selected?: boolean;
  icon?: LucideIcon;
  /** 이모지 등 글자 앞 덧붙임(웹 카테고리 칩의 🍽 처럼). */
  emoji?: string;
  disabled?: boolean;
  className?: string;
};

// 보이는 높이 32pt(웹 h-8) 그대로 두고, 위아래 6pt 를 탭 영역으로 넓혀 44pt 를 채운다 — 웹 .tap-target 과 같은 뜻.
const HIT_SLOP = { top: 6, bottom: 6, left: 0, right: 0 } as const;

/**
 * 고를 수 있는 칩(필터·카테고리). 읽기 화면에 '선택됨' 상태를 알린다. 줄 바꿈 배치는 부모에서 `flex-row flex-wrap gap-[6px]`.
 */
export function Chip({ label, selected = false, icon, emoji, disabled = false, className, accessibilityLabel, ...rest }: ChipProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      hitSlop={HIT_SLOP}
      className={cn(
        'h-[32px] shrink-0 flex-row items-center gap-[6px] rounded-full border px-[12px]',
        selected ? 'border-jade bg-jade-chip' : 'border-line bg-white',
        disabled && 'opacity-50',
        className,
      )}
      {...rest}
    >
      {emoji ? <Text className="text-[13px]">{emoji}</Text> : null}
      {icon ? <Icon icon={icon} size="sm" color={selected ? 'jade' : 'muk-soft'} /> : null}
      <Text className={cn('text-[13px]', selected ? 'text-muk' : 'text-muk-soft')} weight="semibold" numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}
