// SelectField 의 겹치지 않는 공통 부분 — 타입·치수·닫힌 상자 그림. SelectField.tsx(네이티브)와 SelectField.web.tsx 가 같이 쓴다.
// (Metro 는 './SelectField' 를 웹에서 .web.tsx 로 풀기 때문에 .web 파일이 .tsx 를 가져올 수 없어 이 파일이 따로 있다.)
import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { ChevronDown } from 'lucide-react-native';

import { cn } from './cn';
import { Icon } from './Icon';
import { Text } from './Text';

export type SelectVariant = 'control' | 'pill' | 'field';

export type SelectOption<T extends string = string> = { value: T; label: string };

export type SelectFieldProps<T extends string = string> = {
  /**
   * control — 웹 가정 시간 상자(min-h 44 · rounded-xl · 라벨 + 값 + ▾ 12).
   * pill — 웹 LanguageSwitcher 알약(min-h 32 · rounded-full · 앞 아이콘 + 값 + ▾ 14).
   * field — 웹 문의 유형 상자(min-h 58 · rounded-xl · p 16 · 화살표 없음).
   */
  variant: SelectVariant;
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  /** 읽기 이름(웹 aria-label) — 예: t('common.languageSelect'), t('timeSim.label'). */
  accessibilityLabel: string;
  /** 앞에 붙는 그림(Globe 아이콘·🕒 이모지). 장식이라 읽기 화면에서는 숨긴다. */
  leading?: ReactNode;
  /** control 의 흐린 앞 글자(웹 '가정 시간', muk-soft). */
  label?: string;
  className?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

type BoxProps = {
  variant: SelectVariant;
  leading?: ReactNode;
  label?: string;
  valueLabel: string;
  className?: string;
  style?: StyleProp<ViewStyle>;
  /** 웹 빌드: 투명 select 가 키보드 초점을 받았을 때 웹 focus-within 링(gold/60)을 그린다. */
  focused?: boolean;
  children?: ReactNode;
};

const BOX_CLASS: Record<SelectVariant, string> = {
  control: 'min-h-[44px] flex-row items-center gap-[6px] rounded-xl border border-line bg-white px-[12px]',
  pill: 'min-h-[32px] flex-row items-center gap-[6px] self-start rounded-full border border-line bg-white px-[12px]',
  field: 'min-h-[58px] flex-row items-center justify-between rounded-xl border border-line bg-white p-[16px]',
};

// 웹 임의 그림자 값 그대로(tokens 에 이름이 없다 — 보고의 토큰 요청 참고).
const BOX_SHADOW: Record<SelectVariant, string | undefined> = {
  control: '0px 2px 10px rgba(43, 35, 32, 0.06)',
  pill: '0px 2px 14px rgba(43, 35, 32, 0.08)',
  field: undefined,
};

/** 닫힌 상자 — 눌림·열기는 부르는 쪽이 감싼다. 읽기 화면에는 감싼 쪽의 라벨·값이 말한다. */
export function SelectBox({ variant, leading, label, valueLabel, className, style, focused, children }: BoxProps) {
  const ring = '0px 0px 0px 2px rgba(193, 154, 62, 0.6)';
  const base = BOX_SHADOW[variant];
  // 초점 링은 원래 그림자에 더한다(바꿔 끼우면 그림자가 사라진다).
  const boxShadow = focused ? (base ? `${base}, ${ring}` : ring) : base;
  return (
    <View className={cn(BOX_CLASS[variant], className)} style={[boxShadow ? { boxShadow } : null, style]}>
      {leading != null ? (
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {leading}
        </View>
      ) : null}
      {variant === 'control' && label ? (
        <Text className="text-xs text-muk-soft" weight="medium">
          {label}
        </Text>
      ) : null}
      {variant === 'control' ? (
        <Text className="text-xs text-muk" weight="bold">
          {valueLabel}
        </Text>
      ) : variant === 'pill' ? (
        <Text className="text-sm text-muk" weight="medium">
          {valueLabel}
        </Text>
      ) : (
        <Text className="flex-1 text-[16px] text-muk">{valueLabel}</Text>
      )}
      {variant === 'control' ? <Icon icon={ChevronDown} size={12} color="muk-soft" /> : null}
      {variant === 'pill' ? <Icon icon={ChevronDown} size={14} color="muk-soft" /> : null}
      {children}
    </View>
  );
}

export function labelOf<T extends string>(options: SelectOption<T>[], value: T): string {
  return options.find((o) => o.value === value)?.label ?? '';
}
