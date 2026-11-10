import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, shadows } from '~/lib/theme/tokens';

import { Gradient } from './Gradient';
import { Text } from './Text';

// 흰 숫자 대비(D2): 단색은 button-gold(6.78:1), 1위 그라데이션은 시작 cta-from(5.05:1) → gold-deep(6.78:1). 토큰 goldRank(gold 시작, 2.64:1)는 쓰지 않는다.
const RANK1_GRADIENT = [colors['cta-from'], colors['gold-deep']] as const;

export type RankBadgeProps = {
  /** 1부터. 1위는 금 → 금 진 그라데이션(135deg), 그 밖은 단색 금. */
  rank: number;
  /** 지름. 웹 저장·대안 카드 h-8 w-8 → 32(기본), 대기 대표 카드 h-7 w-7 → 28. */
  size?: number;
  /** 자리(absolute top/left 등)는 부르는 쪽이 준다 — 대안 -8/-8, 대기 6/6. 부모는 overflow visible 이어야 한다. */
  style?: StyleProp<ViewStyle>;
};

/**
 * 순위 원 — 웹 `rounded-full border-2 border-white text-[13px] font-extrabold text-white shadow-[0_2px_8px_rgba(193,154,62,0.45)]`.
 * 장식(웹 aria-hidden)이라 읽기 화면에서 숨기고 터치를 받지 않는다. 그림자 바깥 · 자르기 안쪽 두 겹(안드로이드 그림자 잘림).
 */
export function RankBadge({ rank, size = 32, style }: RankBadgeProps) {
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{ width: size, height: size, borderRadius: size / 2, boxShadow: shadows.goldBadge, zIndex: 10 }, style]}
    >
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          overflow: 'hidden',
          borderWidth: 2,
          borderColor: '#ffffff',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors['button-gold'],
        }}
      >
        {rank === 1 ? <Gradient colors={RANK1_GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} /> : null}
        <Text className="text-[13px] text-white" weight="extrabold" style={{ lineHeight: 18 }}>
          {rank}
        </Text>
      </View>
    </View>
  );
}
