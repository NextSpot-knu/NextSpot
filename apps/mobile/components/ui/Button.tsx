import type { LucideIcon } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View, type PressableProps as RNPressableProps } from 'react-native';

import { colors, type FontWeightName } from '~/lib/theme/tokens';

import {
  BUTTON_DEFAULTS,
  LABEL_CLASS,
  SHAPE_CLASS,
  VARIANT_COLOR,
  VARIANT_SURFACE,
  VARIANT_TEXT_CLASS,
  defaultPaddingX,
  paddingYFor,
  shadowFor,
  splitLegacyLayout,
  type ButtonLabelSize,
  type ButtonShadow,
  type ButtonShape,
  type ButtonSize,
  type ButtonVariant,
} from './buttonSpec';
import { cn } from './cn';
import { Gradient } from './Gradient';
import { Icon } from './Icon';
import { Pressable } from './Pressable';
import { Text } from './Text';

export type { ButtonLabelSize, ButtonShadow, ButtonShape, ButtonSize, ButtonVariant } from './buttonSpec';

export type ButtonProps = Omit<RNPressableProps, 'children' | 'style'> & {
  /** 버튼 글자. 읽기 화면도 이것을 읽는다(다르게 읽혀야 하면 accessibilityLabel). */
  label: string;
  /**
   * primary — 주 행동: 금 진→주칠 그라데이션 + 흰 글자(웹 .cta-primary).
   * gold — 단색 금(토큰 button-gold, 그림자 없음) + 흰 글자.
   * secondary — 흰 바탕 + 선 + 먹 글자. hanji — 한지 바탕 + 선 + 먹 글자.
   * dangerSoft — 주칠 10% 바탕·30% 선·주칠 글자. dangerOutline — 바탕 없이 선·글자만.
   * ghost — 바탕 없이 먹 연 글자.
   */
  variant?: ButtonVariant;
  /** 최소 높이(pt). 기본 44. 높이는 클래스가 아니라 style 로 들어간다. */
  size?: ButtonSize;
  /** 글자 크기/줄 높이 짝(12/16 · 13/19.5 · 14/18 · 15/22.5 · 16/24 · 17/25.5). 기본 14. */
  labelSize?: ButtonLabelSize;
  /** 글자 굵기. 기본 bold. */
  labelWeight?: Extract<FontWeightName, 'medium' | 'semibold' | 'bold'>;
  /** 좌우 안쪽 여백(pt). 기본 16(size 30 은 12). */
  paddingX?: number;
  /** 모서리. 기본 2xl(16). */
  shape?: ButtonShape;
  /** auto = primary·활성일 때만 cta. auto 가 아니면 비활성이어도 그린다. */
  shadow?: ButtonShadow;
  /** 왼쪽 아이콘 크기(px). 기본 14. */
  iconSize?: number;
  /** loading 일 때 돌림표를 보일지. 기본 true. false 면 글자·아이콘 그대로(눌리지는 않는다). */
  showSpinner?: boolean;
  /** 비활성(loading 포함) 투명도. 기본 0.5. */
  disabledOpacity?: number;
  /** 왼쪽 아이콘(lucide). */
  icon?: LucideIcon;
  /** 기다리는 중 — 누를 수 없고 읽기 화면에 '바쁨'으로 알린다. */
  loading?: boolean;
  disabled?: boolean;
  /** 가로를 꽉 채운다(기본은 내용 폭). */
  block?: boolean;
  /** 바깥 상자에 붙일 클래스(여백·flex-1 등). 모양은 prop 이 정한다 — min-h-[…]·px-[…] 는 읽어서 style 로 옮기지만 size·paddingX 를 쓴다. */
  className?: string;
  /** 오른쪽 덧붙임(배지 등). */
  trailing?: ReactNode;
};

/**
 * 버튼 — 기본 높이 44pt(DESIGN_PRINCIPLES 측정 기준), 모서리 rounded-2xl. 화면별 값은 docs/parity/review-R1.md 3절 표.
 * 사용 예: `<Button label={t('card.accept')} icon={Footprints} onPress={go} />`
 *          `<Button variant="gold" size={56} labelSize={16} shape="xl" label=… />`
 */
export function Button({
  label,
  variant = 'primary',
  size,
  labelSize = BUTTON_DEFAULTS.labelSize,
  labelWeight = 'bold',
  paddingX,
  shape = BUTTON_DEFAULTS.shape,
  shadow = 'auto',
  iconSize = BUTTON_DEFAULTS.iconSize,
  showSpinner = true,
  disabledOpacity = BUTTON_DEFAULTS.disabledOpacity,
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
  const legacy = splitLegacyLayout(className);
  const minHeight = size ?? legacy.minHeight ?? BUTTON_DEFAULTS.size;
  const px = paddingX ?? legacy.paddingX ?? defaultPaddingX(minHeight);
  const color = VARIANT_COLOR[variant];
  const boxShadow = shadowFor(shadow, variant, inactive);
  const spinning = loading && showSpinner;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      className={cn(
        'flex-row items-center justify-center overflow-hidden',
        SHAPE_CLASS[shape],
        VARIANT_SURFACE[variant],
        block && 'w-full',
        legacy.className,
      )}
      style={{
        minHeight,
        paddingHorizontal: px,
        paddingVertical: paddingYFor(minHeight),
        opacity: inactive ? disabledOpacity : undefined,
        boxShadow,
      }}
      {...rest}
    >
      {variant === 'primary' && <Gradient name="cta" style={StyleSheet.absoluteFill} pointerEvents="none" />}
      <View className="flex-row items-center justify-center gap-[6px]">
        {spinning ? (
          <ActivityIndicator size="small" color={colors[color]} />
        ) : (
          icon && <Icon icon={icon} size={iconSize} color={color} />
        )}
        <Text className={cn('text-center', LABEL_CLASS[labelSize], VARIANT_TEXT_CLASS[variant])} weight={labelWeight}>
          {label}
        </Text>
        {trailing}
      </View>
    </Pressable>
  );
}
