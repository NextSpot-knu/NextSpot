import type { LucideIcon } from 'lucide-react-native';
import { View } from 'react-native';

import { Button } from './Button';
import { Card } from './Card';
import { cn } from './cn';
import { Icon } from './Icon';
import { Text } from './Text';

export type EmptyStateProps = {
  /** 한 문장 — 무엇이 없는지가 아니라 다음에 무엇을 하면 되는지 쪽으로(해요체). */
  title: string;
  description?: string;
  icon?: LucideIcon;
  /** 아이콘 대신 이모지(웹 빈 상태의 🗺️ 같은). */
  emoji?: string;
  /** 다음 행동 하나(있으면). 보조 버튼 모양이다 — 빈 상태가 화면의 주 행동을 빼앗지 않게. */
  action?: { label: string; onPress: () => void };
  className?: string;
};

/**
 * 비어 있음. 조회 실패에는 쓰지 않는다 — 실패를 빈 목록처럼 보여 주면 '주변에 갈 곳이 없어요' 같은 사실이 아닌 문장이 나간다.
 * 실패는 ErrorState.
 */
export function EmptyState({ title, description, icon, emoji, action, className }: EmptyStateProps) {
  return (
    <Card className={cn('items-center gap-[10px]', className)} padded={false} style={{ padding: 28 }}>
      {emoji ? (
        <Text className="text-[30px] leading-[36px]" accessibilityElementsHidden importantForAccessibility="no">
          {emoji}
        </Text>
      ) : icon ? (
        <View className="h-[48px] w-[48px] items-center justify-center rounded-full bg-hanji-deep">
          <Icon icon={icon} size="xl" color="muk-soft" />
        </View>
      ) : null}
      <Text className="text-center text-[15px] leading-[21px]" weight="bold" accessibilityRole="header">
        {title}
      </Text>
      {description ? <Text className="text-center text-[13px] leading-[19px] text-muk-soft">{description}</Text> : null}
      {action ? <Button className="mt-[4px]" variant="secondary" label={action.label} onPress={action.onPress} /> : null}
    </Card>
  );
}
