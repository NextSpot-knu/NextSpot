import { LinearGradient, type LinearGradientProps } from 'expo-linear-gradient';
import { cssInterop } from 'nativewind';

import { gradients } from '~/lib/theme/tokens';

// expo-linear-gradient 는 RN 기본 컴포넌트가 아니라 className 을 받으려면 등록이 필요하다.
cssInterop(LinearGradient, { className: 'style' });

export type GradientName = keyof typeof gradients;

export type GradientProps = Omit<LinearGradientProps, 'colors'> & {
  className?: string;
  /** 토큰 그라데이션 이름(cta · goldTerracotta · sunset). colors 를 주면 그것이 이긴다. */
  name?: GradientName;
  colors?: LinearGradientProps['colors'];
};

/**
 * 웹 `bg-gradient-to-*`·`.cta-primary` 의 대체. 방향은 start·end(0~1)로 — 기본은 토큰 방향(90deg = 왼→오).
 * 글자 그라데이션(.gradient-text)은 RN 에 없다 — 단색 금 진(text-gold-deep)으로 쓴다.
 */
export function Gradient({ name = 'cta', colors, start, end, ...rest }: GradientProps) {
  const token = gradients[name];
  return (
    <LinearGradient
      colors={colors ?? token.colors}
      start={start ?? token.start}
      end={end ?? token.end}
      {...rest}
    />
  );
}
