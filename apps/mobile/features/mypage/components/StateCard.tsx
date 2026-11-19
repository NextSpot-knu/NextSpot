// 마이 하위 화면의 상태 카드(빈·로그인 필요·오류) — 웹 coupons·lab 의 `bg-white border-line rounded-3xl p-8 max-w-[320px]` 카드(G5b-21).
// 세로 가운데: 바깥 View 가 flex-1 + 가운데(SubScreen 의 안쪽 View 가 flex-1 이라 남는 높이를 채운다).
import type { LucideIcon } from 'lucide-react-native';
import { View } from 'react-native';

import { Button, Card, Gradient, Icon, Text } from '~/components/ui';
import { colors } from '~/lib/theme/tokens';

export type StateCardProps = {
  /** gold = 금 그라데이션 원 + 금 아이콘 · error = 주칠 10% 원 + 주칠 아이콘. */
  tone?: 'gold' | 'error';
  icon: LucideIcon;
  title?: string;
  body?: string;
  action?: { label: string; onPress: () => void; icon?: LucideIcon };
};

export function StateCard({ tone = 'gold', icon, title, body, action }: StateCardProps) {
  const error = tone === 'error';
  return (
    <View className="w-full flex-1 items-center justify-center">
      <Card padded={false} className="w-full max-w-[320px] items-center rounded-3xl" style={{ padding: 32 }}>
        <View
          className={`mb-[24px] h-[64px] w-[64px] items-center justify-center overflow-hidden rounded-full border ${error ? 'border-terracotta/20 bg-terracotta/10' : 'border-line'}`}
        >
          {error ? null : (
            <Gradient
              colors={['rgba(193, 154, 62, 0.2)', 'rgba(193, 154, 62, 0.1)']}
              start={{ x: 0.5, y: 0 }}
              end={{ x: 0.5, y: 1 }}
              style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
              pointerEvents="none"
            />
          )}
          <Icon icon={icon} size={32} color={error ? colors.terracotta : colors.gold} />
        </View>
        {title ? <Text className="mb-[12px] text-center text-xl" weight="bold" accessibilityRole="header">{title}</Text> : null}
        {body ? (
          <Text className={`px-[8px] text-center text-sm leading-[22.75px] text-muk-soft ${action ? 'mb-[32px]' : ''}`}>{body}</Text>
        ) : null}
        {action ? (
          <Button
            variant="gold"
            labelWeight="semibold"
            shape="xl"
            iconSize={18}
            icon={action.icon}
            label={action.label}
            className="min-h-[40px] px-[20px]"
            onPress={action.onPress}
          />
        ) : null}
      </Card>
    </View>
  );
}
