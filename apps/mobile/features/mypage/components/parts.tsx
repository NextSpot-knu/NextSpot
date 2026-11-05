// 마이페이지 화면들이 같이 쓰는 작은 조각.
import type { LucideIcon } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { TextInput, View, type TextInputProps } from 'react-native';

import { Card, Icon, Skeleton, Text } from '~/components/ui';
import { colors, fontFamilies, type ColorToken } from '~/lib/theme/tokens';

/** 글 입력칸 — 웹 input/textarea(bg-white border-line rounded-xl). 글꼴은 Text 와 같은 Freesentation, 높이 48pt 이상. */
export function TextField({
  multiline = false,
  minHeight,
  style,
  ...rest
}: TextInputProps & { minHeight?: number }) {
  return (
    <TextInput
      multiline={multiline}
      textAlignVertical={multiline ? 'top' : 'center'}
      placeholderTextColor={colors['muk-soft']}
      maxFontSizeMultiplier={1.6}
      className="rounded-xl border border-line bg-white px-[14px] py-[12px] text-base text-muk"
      style={[{ fontFamily: fontFamilies.regular, minHeight: multiline ? (minHeight ?? 96) : 48 }, style]}
      {...rest}
    />
  );
}

/** 아이콘 원 + 제목 + 설명이 달린 설정 카드(웹 settings 의 section). */
export function SectionCard({
  icon,
  tone = 'gold',
  title,
  desc,
  children,
  danger = false,
}: {
  icon: LucideIcon;
  tone?: ColorToken;
  title: string;
  desc?: string;
  children?: ReactNode;
  danger?: boolean;
}) {
  return (
    <Card className={danger ? 'gap-[12px] border-terracotta/35' : 'gap-[12px]'}>
      <View className="flex-row items-center gap-[12px]">
        <View className="h-[40px] w-[40px] items-center justify-center rounded-full bg-hanji-deep">
          <Icon icon={icon} size="lg" color={tone} />
        </View>
        <View className="min-w-0 flex-1">
          <Text className="text-base" weight="bold" accessibilityRole="header">{title}</Text>
          {desc ? <Text className="text-xs leading-[18px] text-muk-soft">{desc}</Text> : null}
        </View>
      </View>
      {children}
    </Card>
  );
}

/** 카드 모양 스켈레톤 줄들 — 불러오는 중. */
export function CardSkeletons({ count = 2, label }: { count?: number; label: string }) {
  return (
    <View className="gap-[16px]" accessibilityLabel={label} accessibilityState={{ busy: true }} accessible>
      {Array.from({ length: count }, (_, i) => (
        <Card key={i} className="gap-[10px]">
          <Skeleton width="40%" height={16} />
          <Skeleton width="65%" height={20} />
          <Skeleton width="30%" height={12} />
        </Card>
      ))}
    </View>
  );
}
