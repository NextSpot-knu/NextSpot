import type { ReactNode } from 'react';
import { View, type ViewProps } from 'react-native';

import { shadows } from '~/lib/theme/tokens';

import { cardClassName } from './cardClassName';
import { Pressable } from './Pressable';

export type CardProps = ViewProps & {
  className?: string;
  children?: ReactNode;
  /** 주면 카드 전체가 누를 수 있다(누름 피드백 + 버튼 역할). 그때는 accessibilityLabel 을 함께 준다. */
  onPress?: () => void;
  /** 그림자 단계 — card(기본, 옅게) · surface(떠 있는 판) · none. */
  elevation?: 'card' | 'surface' | 'none';
  /** 기본 안쪽 여백 16pt. 다른 여백을 className 으로 주려면 false(같은 속성 클래스 둘은 쓴 순서대로 이기지 않는다).
   *  바탕·테두리 색·두께·둥글기는 className 에 같은 종류가 있으면 기본값을 빼므로 그냥 주면 된다. */
  padded?: boolean;
};

/** 내용 판 — 흰 바탕 + 따뜻한 선 + 옅은 그림자 + rounded-2xl(웹 ErrorState·목록 카드와 같은 모양). 기본값은 cardClassName. */
export function Card({
  className,
  children,
  onPress,
  elevation = 'card',
  padded = true,
  style,
  accessibilityLabel,
  ...rest
}: CardProps) {
  const classes = cardClassName(className, padded);
  const shadow = elevation === 'none' ? undefined : { boxShadow: shadows[elevation] };
  if (onPress) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        onPress={onPress}
        className={classes}
        style={[shadow, style]}
        {...rest}
      >
        {children}
      </Pressable>
    );
  }
  return (
    <View className={classes} style={[shadow, style]} accessibilityLabel={accessibilityLabel} {...rest}>
      {children}
    </View>
  );
}
