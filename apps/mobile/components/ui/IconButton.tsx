import type { LucideIcon } from 'lucide-react-native';
import type { PressableProps as RNPressableProps } from 'react-native';

import { MIN_TAP, iconSizes, type ColorToken, type IconSize } from '~/lib/theme/tokens';

import { cn } from './cn';
import { Icon } from './Icon';
import { Pressable } from './Pressable';

export type IconButtonProps = Omit<RNPressableProps, 'children' | 'style' | 'accessibilityLabel'> & {
  icon: LucideIcon;
  /** 필수 — 글자가 없으니 읽기 화면은 이것만 읽는다(예: t('common.close')). */
  accessibilityLabel: string;
  /** 아이콘 크기(xs 12 · sm 14 · md 16 · lg 20 · xl 24). 기본 lg. */
  size?: IconSize;
  /** 보이는 상자 한 변(pt). 기본 36 — 탭 영역은 hitSlop 으로 44pt 를 채운다. */
  box?: number;
  color?: ColorToken | (string & {});
  disabled?: boolean;
  /** 바깥 상자 클래스(바탕·테두리·둥글기 등). 기본은 둥근 투명 상자. */
  className?: string;
};

/**
 * 아이콘만 있는 버튼(닫기 X · 공유 · 즐겨찾기). 보이는 크기가 작아도 탭 영역은 44pt(웹 .tap-target) — 모자란 만큼 hitSlop.
 * 라벨 없이는 쓸 수 없다(accessibilityLabel 필수).
 */
export function IconButton({
  icon,
  accessibilityLabel,
  size = 'lg',
  box = 36,
  color = 'muk',
  disabled = false,
  className,
  accessibilityState,
  ...rest
}: IconButtonProps) {
  const slop = Math.max(0, Math.ceil((MIN_TAP - box) / 2));
  const side = Math.max(box, iconSizes[size]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ ...accessibilityState, disabled }}
      disabled={disabled}
      hitSlop={{ top: slop, bottom: slop, left: slop, right: slop }}
      className={cn('items-center justify-center rounded-full', disabled && 'opacity-50', className)}
      style={{ width: side, height: side }}
      {...rest}
    >
      <Icon icon={icon} size={size} color={color} />
    </Pressable>
  );
}
