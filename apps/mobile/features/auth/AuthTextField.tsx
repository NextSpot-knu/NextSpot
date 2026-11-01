// 로그인·재설정 화면의 입력 칸 — 웹 login/page.tsx 의 '아이콘 + 입력' 라벨 상자(bg-white border-line rounded-xl px-3.5 py-3).
// 포커스 테두리 border-gold 는 웹 focus-within:border-gold 와 같다(rules 4 — 같은 속성 클래스를 겹치지 않게 삼항으로).
import type { LucideIcon } from 'lucide-react-native';
import { forwardRef, useState } from 'react';
import { TextInput, View, type TextInputProps } from 'react-native';

import { cn, Icon } from '~/components/ui';
import { colors, fontFamilies } from '~/lib/theme/tokens';

export type AuthTextFieldProps = Omit<TextInputProps, 'style' | 'placeholderTextColor'> & {
  icon: LucideIcon;
  /** 화면에 보이는 자리 글자이자 읽기 화면 라벨. */
  label: string;
};

export const AuthTextField = forwardRef<TextInput, AuthTextFieldProps>(function AuthTextField(
  { icon, label, onFocus, onBlur, ...rest },
  ref,
) {
  const [focused, setFocused] = useState(false);
  return (
    <View
      className={cn(
        'min-h-[48px] flex-row items-center gap-[8px] rounded-xl border bg-white px-[14px]',
        focused ? 'border-gold' : 'border-line',
      )}
    >
      <Icon icon={icon} size={18} color="muk-soft" />
      <TextInput
        ref={ref}
        accessibilityLabel={label}
        placeholder={label}
        placeholderTextColor={colors['muk-soft']}
        maxFontSizeMultiplier={1.6}
        style={{ flex: 1, minHeight: 44, color: colors.muk, fontFamily: fontFamilies.regular, fontSize: 16 }}
        onFocus={(e) => {
          setFocused(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          onBlur?.(e);
        }}
        {...rest}
      />
    </View>
  );
});
