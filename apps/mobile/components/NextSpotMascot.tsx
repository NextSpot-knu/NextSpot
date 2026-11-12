import { Image } from 'expo-image';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { colors } from '~/lib/theme/tokens';

// 웹 components/NextSpotMascot.tsx(f4dc88b 이후 42a294b) — 경주 여행 길잡이 마스코트. 장식이라 읽기 화면에서 숨긴다.
// 자산은 웹 public/mascot/nextspot-guide.webp 512×512 원본 그대로.
const SOURCE = require('../assets/images/mascot/nextspot-guide.webp');

export type NextSpotMascotProps = {
  /** avatar: 정사각 원(테두리 gold 35%, 확대 1.48, 그림 위치 50% 22%) · full: 4:5(모서리 폭×0.28, 그림 위치 50% 42%). */
  variant?: 'avatar' | 'full';
  /** 폭(px). 웹 className 의 w-… 를 값으로: 아바타 기본 48 · full 기본 80(지도 불러오는 중), 404 는 96. */
  size?: number;
  /** 바깥 그림자(boxShadow 문자열). 기본: avatar 는 웹 shadow-sm, full 은 없음(지도 불러오는 중은 '0px 8px 24px rgba(43,35,32,0.10)'). */
  shadow?: string;
  style?: StyleProp<ViewStyle>;
};

const SHADOW_SM = '0px 1px 3px rgba(0, 0, 0, 0.1), 0px 1px 2px -1px rgba(0, 0, 0, 0.1)';

export function NextSpotMascot({ variant = 'avatar', size, shadow, style }: NextSpotMascotProps) {
  const isAvatar = variant === 'avatar';
  const width = size ?? (isAvatar ? 48 : 80);
  const height = isAvatar ? width : (width * 5) / 4;
  const radius = isAvatar ? width / 2 : width * 0.28;
  // 안드로이드·iOS 는 overflow hidden 뷰의 그림자를 자르므로 바깥(그림자)·안쪽(자르기) 두 겹.
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        { width, height, borderRadius: radius, boxShadow: shadow ?? (isAvatar ? SHADOW_SM : undefined) },
        style,
      ]}
    >
      <View
        style={{
          width,
          height,
          borderRadius: radius,
          overflow: 'hidden',
          backgroundColor: colors.hanji,
          borderWidth: isAvatar ? 1 : 0,
          borderColor: 'rgba(193, 154, 62, 0.35)',
        }}
      >
        <Image
          source={SOURCE}
          contentFit="cover"
          contentPosition={{ top: isAvatar ? '22%' : '42%', left: '50%' }}
          style={[{ width: '100%', height: '100%' }, isAvatar ? { transform: [{ scale: 1.48 }] } : null]}
        />
      </View>
    </View>
  );
}

export default NextSpotMascot;
