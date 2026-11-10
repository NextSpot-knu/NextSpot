// 저장 빈 상태 — 웹 saved/page.tsx 빈 카드(폭 320 · p-8 · rounded-3xl · 금빛 원 64 · 나침반 CTA). 공용 EmptyState 는 그대로 두고 이 화면 전용으로 그린다(§4.3 EmptyState).
import { Compass, Star } from 'lucide-react-native';
import { View } from 'react-native';

import { Button, Gradient, Icon, Text } from '~/components/ui';
import { colors, shadows } from '~/lib/theme/tokens';

export interface SavedEmptyProps {
  title: string;
  body: string;
  ctaLabel: string;
  onCta: () => void;
}

export function SavedEmpty({ title, body, ctaLabel, onCta }: SavedEmptyProps) {
  return (
    <View
      className="w-full max-w-[320px] items-center self-center rounded-3xl border border-line bg-white p-[32px]"
      style={{ boxShadow: shadows.card }}
    >
      {/* 원 — 웹 bg-gradient-to-b from-gold/20 to-gold/10 border-line, 별 32 채움 gold/40 */}
      <Gradient
        colors={['rgba(193,154,62,0.2)', 'rgba(193,154,62,0.1)']}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={{
          width: 64,
          height: 64,
          borderRadius: 32,
          borderWidth: 1,
          borderColor: colors.line,
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 24,
        }}
      >
        <Icon icon={Star} size={32} color="gold" fill="rgba(193,154,62,0.4)" />
      </Gradient>
      <Text className="mb-[12px] text-center text-[20px] leading-[28px]" weight="bold" accessibilityRole="header">
        {title}
      </Text>
      <Text className="mb-[32px] px-[8px] text-center text-[14px] leading-[22.75px] text-muk-soft">{body}</Text>
      {/* 이 화면의 유일한 주 행동 — F7: 화면 전용 빈 상태의 CTA 는 primary·full. */}
      <Button variant="primary" shape="full" size={44} labelSize={14} paddingX={20} icon={Compass} iconSize={18} label={ctaLabel} onPress={onCta} />
    </View>
  );
}
