import type { LucideIcon } from 'lucide-react-native';

import { colors, iconSizes, type ColorToken, type IconSize } from '~/lib/theme/tokens';

export type IconProps = {
  /** lucide-react-native 아이콘 컴포넌트(웹 lucide-react 와 같은 이름). 예: `import { Clock } from 'lucide-react-native'`. */
  icon: LucideIcon;
  /** 이름(xs 12 · sm 14 · md 16 · lg 20 · xl 24) 또는 px. 기본 md. */
  size?: IconSize | number;
  /** 색 토큰 이름(muk · gold-deep · jade …) 또는 색 문자열. 기본 muk. */
  color?: ColorToken | (string & {});
  strokeWidth?: number;
  /**
   * 뜻이 있는 아이콘(글자 없이 홀로 선 아이콘)만 라벨을 준다. 없으면 읽기 화면에서 숨긴다 — 웹 aria-hidden 과 같다.
   * 누를 수 있는 아이콘은 라벨을 감싼 Pressable 에 주고, 탭 영역 44pt 도 그쪽에서 지킨다.
   */
  accessibilityLabel?: string;
};

export function Icon({ icon: LucideComponent, size = 'md', color = 'muk', strokeWidth = 2, accessibilityLabel }: IconProps) {
  const px = typeof size === 'number' ? size : iconSizes[size];
  const stroke = color in colors ? colors[color as ColorToken] : color;
  return (
    <LucideComponent
      size={px}
      color={stroke}
      strokeWidth={strokeWidth}
      accessible={Boolean(accessibilityLabel)}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={accessibilityLabel ? 'image' : undefined}
      importantForAccessibility={accessibilityLabel ? 'yes' : 'no-hide-descendants'}
      accessibilityElementsHidden={!accessibilityLabel}
    />
  );
}
