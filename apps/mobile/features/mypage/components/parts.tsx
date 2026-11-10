// 마이페이지 화면들이 같이 쓰는 작은 조각 — 입력칸 · 설정 카드 · 스켈레톤 · 하위 화면 틀(광원·바닥 간격).
import type { LucideIcon } from 'lucide-react-native';
import { useState, type ReactNode, type Ref } from 'react';
import { Platform, StyleSheet, TextInput, View, useWindowDimensions, type TextInputProps } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useNavInsets } from '~/components/navigation/navMetrics';
import { Card, Glow, Icon, Screen, Skeleton, Text } from '~/components/ui';
import { colors, fontFamilies, type ColorToken } from '~/lib/theme/tokens';

import { SUB_HEADER_HEIGHT } from './SubPageHeader';

/**
 * 글 입력칸 — 웹 input/textarea. 글꼴은 Text 와 같은 Freesentation. 포커스 때 테두리가 금색(웹 `focus:border-gold`).
 * size: modal = 프로필 수정(p-3.5 · 16/24 → 54) · field = 문의(p-4 → 58) · sm = 실험실 메모(p-3 · 14/20).
 * 안드로이드 멀티라인은 `rows`(고정 높이 — 웹 textarea rows · 안에서 스크롤)나 height 를 주지 않으면 내용 따라 자란다.
 */
type TextFieldSize = 'md' | 'modal' | 'field' | 'sm';
const FIELD_SPEC: Record<TextFieldSize, { px: number; py: number; fontSize: number; lineHeight?: number }> = {
  md: { px: 14, py: 12, fontSize: 16 },
  modal: { px: 14, py: 14, fontSize: 16, lineHeight: 24 },
  field: { px: 16, py: 16, fontSize: 16, lineHeight: 24 },
  sm: { px: 12, py: 12, fontSize: 14, lineHeight: 20 },
};

export function TextField({
  multiline = false,
  minHeight,
  rows,
  height,
  tone = 'white',
  size = 'md',
  inputRef,
  style,
  onFocus,
  onBlur,
  ...rest
}: TextInputProps & { minHeight?: number; rows?: number; height?: number; tone?: 'white' | 'hanji'; size?: TextFieldSize; inputRef?: Ref<TextInput> }) {
  const [focused, setFocused] = useState(false);
  const spec = FIELD_SPEC[size];
  const lh = spec.lineHeight ?? Math.round(spec.fontSize * 1.5);
  // 웹 textarea rows=N: 높이 = N × 줄 높이 + 위아래 안쪽 여백(테두리 포함 상자) — 안에서 스크롤.
  const fixed = height ?? (rows ? rows * lh + spec.py * 2 : undefined);
  const single = lh + spec.py * 2 + 2;
  return (
    <TextInput
      ref={inputRef}
      multiline={multiline}
      textAlignVertical={multiline ? 'top' : 'center'}
      placeholderTextColor="rgba(107, 93, 79, 0.7)"
      maxFontSizeMultiplier={1.6}
      onFocus={(e) => { setFocused(true); onFocus?.(e); }}
      onBlur={(e) => { setFocused(false); onBlur?.(e); }}
      className={`rounded-xl border border-line text-muk ${tone === 'hanji' ? 'bg-hanji' : 'bg-white'}`}
      style={[
        {
          fontFamily: fontFamilies.regular,
          fontSize: spec.fontSize,
          lineHeight: spec.lineHeight,
          paddingHorizontal: spec.px,
          paddingVertical: spec.py,
          ...(fixed !== undefined ? { height: fixed } : { minHeight: multiline ? (minHeight ?? 96) : single }),
        },
        focused ? { borderColor: colors.gold } : null,
        // 웹 빌드: 브라우저 기본 포커스 윤곽 대신 위 금색 테두리만(웹 `outline-none`).
        Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : null,
        style,
      ]}
      {...rest}
    />
  );
}

/** 아이콘 원 바탕 — NativeWind 는 `bg-${tone}/10` 을 못 찾으므로 고정 맵(웹 settings 각 절의 원 색). */
const CIRCLE_BG: Partial<Record<ColorToken, string>> = {
  jade: 'bg-jade/10',
  gold: 'bg-gold/10',
  'gold-deep': 'bg-gold/10',
  terracotta: 'bg-terracotta/10',
  'muk-soft': 'bg-muk/5',
};

/** 아이콘 원 + 제목 + 설명이 달린 설정 카드(웹 settings 의 section: rounded-3xl p-5). */
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
    <Card
      padded={false}
      className={danger ? 'rounded-3xl border-terracotta/35' : 'rounded-3xl'}
      style={{ padding: 20, gap: 12 }}
    >
      <View className="flex-row items-center gap-[12px]">
        <View className={`h-[40px] w-[40px] items-center justify-center rounded-full ${CIRCLE_BG[tone] ?? 'bg-hanji-deep'}`}>
          <Icon icon={icon} size="lg" color={tone} />
        </View>
        <View className="min-w-0 flex-1">
          <Text className="text-base" weight="bold" accessibilityRole="header">{title}</Text>
          {desc ? <Text className="text-xs text-muk-soft">{desc}</Text> : null}
        </View>
      </View>
      {children}
    </Card>
  );
}

/** 카드 모양 스켈레톤 줄들 — 내 문의 등 불러오는 중. */
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

/** 쿠폰 티켓 모양 스켈레톤(웹 coupons 로딩) — 왼쪽 w-80 스텁 + 오른쪽 막대 셋, 둘. */
export function CouponSkeletons({ label }: { label: string }) {
  return (
    <View className="gap-[16px]" accessibilityLabel={label} accessibilityState={{ busy: true }} accessible>
      {[0, 1].map((i) => (
        <Card key={i} padded={false} className="flex-row items-stretch overflow-hidden">
          <Skeleton width={80} height="100%" radius={0} />
          <View className="flex-1 justify-center gap-[8px] px-[16px] py-[16px]">
            <Skeleton width="33%" height={16} />
            <Skeleton width="66%" height={20} />
            <Skeleton width="25%" height={12} />
          </View>
        </Card>
      ))}
    </View>
  );
}

/** 실험실 로딩(웹 lab) — rounded-3xl p-5 카드: 막대 2/5×20 · 1/3×12 + 칩 96/112/80 × 32. */
export function LabSkeletons({ label }: { label: string }) {
  return (
    <View className="gap-[16px]" accessibilityLabel={label} accessibilityState={{ busy: true }} accessible>
      {[0, 1, 2].map((i) => (
        <Card key={i} padded={false} className="rounded-3xl" style={{ padding: 20 }}>
          <Skeleton width="40%" height={20} />
          <View className="mt-[8px]"><Skeleton width="33%" height={12} /></View>
          <View className="mt-[16px] flex-row flex-wrap gap-[8px]">
            <Skeleton width={96} height={32} radius={16} />
            <Skeleton width={112} height={32} radius={16} />
            <Skeleton width={80} height={32} radius={16} />
          </View>
        </Card>
      ))}
    </View>
  );
}

/**
 * 웹 페이지 틀의 노을 광원(`absolute top-1/4 left|right-1/4 w-[300px] blur-[100px] bg-sunset-1/10`) — 쿠폰·개인정보·설정.
 * 웹 틀은 화면 높이(100dvh) 전체라 top 1/4 = 화면 위에서 25% 지점. 앱은 머리(Stack)가 위를 차지하니 그만큼 뺀다.
 * 자르기는 광원 전용 상자에 준다(루트 overflow-hidden 은 웹 빌드에서 가로 스크롤을 만든다).
 */
function PageGlow({ side }: { side: 'left' | 'right' }) {
  const { height } = useWindowDimensions();
  const { top } = useSafeAreaInsets();
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { overflow: 'hidden' }]}>
      <Glow
        color="sunset-1"
        opacity={0.1}
        size={300}
        blur={100}
        position={{ top: height * 0.25 - (top + SUB_HEADER_HEIGHT), [side]: '25%' }}
      />
    </View>
  );
}

/**
 * 마이 하위 화면(고정 머리 다섯) 틀 — 웹 `main px-6 pb-[clearance]` : 좌우 24 · 위 `topGap` · 아래 NAV_GAP(막대 위 간격) · 화면 안 간격 16.
 * `glow` 를 주면 그 쪽 노을 광원을 스크롤과 무관하게 고정으로 깐다. `centered` 는 상태 카드를 세로 가운데로(웹 `flex-1 items-center justify-center`).
 */
export function SubScreen({
  children,
  glow,
  topGap = 8,
  gap = 16,
  keyboardDismiss = false,
}: {
  children: ReactNode;
  glow?: 'left' | 'right';
  topGap?: number;
  gap?: number;
  keyboardDismiss?: boolean;
}) {
  const nav = useNavInsets();
  return (
    <View className="flex-1 bg-hanji">
      {glow ? <PageGlow side={glow} /> : null}
      <Screen
        scroll
        edges={['left', 'right']}
        className="bg-transparent"
        contentClassName="px-[24px]"
        scrollProps={keyboardDismiss ? { keyboardDismissMode: 'on-drag' } : undefined}
      >
        <View className="flex-1" style={{ paddingTop: topGap, paddingBottom: nav.gap, gap }}>
          {children}
        </View>
      </Screen>
    </View>
  );
}
