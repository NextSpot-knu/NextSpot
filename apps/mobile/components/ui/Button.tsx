import type { LucideIcon } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View, type PressableProps as RNPressableProps } from 'react-native';

import { colors, shadows, type ColorToken } from '~/lib/theme/tokens';

import { cn } from './cn';
import { Gradient } from './Gradient';
import { Icon } from './Icon';
import { Pressable } from './Pressable';
import { Text } from './Text';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

export type ButtonProps = Omit<RNPressableProps, 'children' | 'style'> & {
  /** 버튼 글자. 읽기 화면도 이것을 읽는다(다르게 읽혀야 하면 accessibilityLabel). */
  label: string;
  /**
   * primary — 주 행동(카드·화면마다 하나): 금 진→주칠 그라데이션 + 흰 글자(웹 .cta-primary, 4.5:1 이상).
   * secondary — 보조 행동: 흰 바탕 + 선 + 먹 글자.
   * ghost — 가장 약한 행동: 바탕 없이 먹 연 글자.
   */
  variant?: ButtonVariant;
  /** 왼쪽 아이콘(lucide). */
  icon?: LucideIcon;
  /** 기다리는 중 — 누를 수 없고 돌림표를 보인다. 읽기 화면에 '바쁨'으로 알린다. */
  loading?: boolean;
  disabled?: boolean;
  /** 가로를 꽉 채운다(기본은 내용 폭). */
  block?: boolean;
  /** 바깥 상자에 붙일 클래스(여백·flex-1 등). 모양은 variant 가 정한다. */
  className?: string;
  /** 오른쪽 덧붙임(배지 등). */
  trailing?: ReactNode;
};

const TEXT_CLASS: Record<ButtonVariant, string> = {
  primary: 'text-white',
  secondary: 'text-muk',
  ghost: 'text-muk-soft',
};
const SPINNER: Record<ButtonVariant, ColorToken> = { primary: 'white', secondary: 'muk', ghost: 'muk-soft' };

/**
 * 버튼 — 높이 최소 44pt(DESIGN_PRINCIPLES 측정 기준). 모서리는 웹 카드 버튼과 같은 rounded-2xl.
 * 사용 예: `<Button label={t('card.walk')} icon={Footprints} onPress={go} />`
 */
export function Button({
  label,
  variant = 'primary',
  icon,
  loading = false,
  disabled = false,
  block = false,
  className,
  trailing,
  accessibilityLabel,
  accessibilityHint,
  ...rest
}: ButtonProps) {
  const inactive = disabled || loading;
  const textColor = variant === 'primary' ? colors.white : variant === 'secondary' ? colors.muk : colors['muk-soft'];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      className={cn(
        'min-h-[44px] flex-row items-center justify-center overflow-hidden rounded-2xl px-[16px] py-[8px]',
        block && 'w-full',
        variant === 'secondary' && 'border border-line bg-white',
        inactive && 'opacity-50',
        className,
      )}
      style={variant === 'primary' && !inactive ? { boxShadow: shadows.cta } : undefined}
      {...rest}
    >
      {variant === 'primary' && <Gradient name="cta" style={StyleSheet.absoluteFill} pointerEvents="none" />}
      <View className="flex-row items-center justify-center gap-[6px]">
        {loading ? (
          <ActivityIndicator size="small" color={colors[SPINNER[variant]]} />
        ) : (
          icon && <Icon icon={icon} size="sm" color={textColor} />
        )}
        <Text className={cn('text-center text-[14px] leading-[18px]', TEXT_CLASS[variant])} weight="bold">
          {label}
        </Text>
        {trailing}
      </View>
    </Pressable>
  );
}
