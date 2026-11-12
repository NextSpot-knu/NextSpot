// 내 문의의 상태 표시 — 웹 inquiries 는 카드 없이 가운데 아이콘 + 문장(+ 금 버튼)이다(G5b-25).
import type { LucideIcon } from 'lucide-react-native';
import { ActivityIndicator, View } from 'react-native';

import { Button, Icon, Text } from '~/components/ui';
import { colors } from '~/lib/theme/tokens';

export function InlineLoading({ label }: { label: string }) {
  return (
    <View className="items-center justify-center py-[64px]" accessible accessibilityLabel={label} accessibilityState={{ busy: true }}>
      <ActivityIndicator size="large" color={colors.gold} />
      <Text className="mt-[12px] text-sm text-muk-soft">{label}</Text>
    </View>
  );
}

export function InlineState({
  icon,
  iconColor,
  text,
  strong = false,
  action,
}: {
  icon: LucideIcon;
  iconColor: string;
  text: string;
  /** 오류 줄(font-semibold text-muk) — 아니면 text-sm muk-soft. */
  strong?: boolean;
  action?: { label: string; onPress: () => void };
}) {
  return (
    <View className="items-center justify-center py-[56px]">
      <Icon icon={icon} size={40} color={iconColor} />
      <Text
        className={`mt-[12px] text-center ${strong ? 'text-base text-muk' : 'text-sm text-muk-soft'}`}
        weight={strong ? 'semibold' : 'regular'}
        accessibilityRole={strong ? 'alert' : undefined}
      >
        {text}
      </Text>
      {action ? (
        <Button className="mt-[20px] min-h-[40px] px-[24px]" variant="gold" shape="xl" label={action.label} onPress={action.onPress} />
      ) : null}
    </View>
  );
}
