// 서비스 소개 절 머리 — kicker + 절 제목(웹 guide.module.css .kicker·.sectionTitle, 모바일 값).
//   kicker 13px 800 gold-deep 자간 .09em mb 14 · 제목 25px 800 줄높이 1.22 자간 −.045em(pre-line — RN Text 는 \n 을 줄바꿈으로 그린다).
import { View } from 'react-native';

import { Text } from '~/components/ui';

export function SectionHead({ kicker, title }: { kicker: string; title: string }) {
  return (
    <View>
      <Text className="mb-[14px] text-[13px] leading-[19.5px] text-gold-deep" weight="extrabold" style={{ letterSpacing: 1.17 }}>
        {kicker}
      </Text>
      <Text className="text-[25px] leading-[30.5px] text-muk" weight="extrabold" accessibilityRole="header" style={{ letterSpacing: -1.125 }}>
        {title}
      </Text>
    </View>
  );
}
