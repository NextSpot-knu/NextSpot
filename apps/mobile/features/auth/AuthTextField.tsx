// 로그인·재설정 화면의 입력 칸 — 웹 login/page.tsx 의 '아이콘 + 입력' 라벨 상자(bg-white border-line rounded-xl px-3.5 py-3 = 50px).
// 포커스 테두리 border-gold 는 웹 focus-within:border-gold 와 같다(rules 4 — 같은 속성 클래스를 겹치지 않게 삼항으로).
// 높이 50: 상자는 세로 여백 없이 min-h 50, 입력은 minHeight 48 + paddingVertical 0(테두리 1+1) — 누르는 자리가 상자 전체다
// (RN View 는 웹 <label> 처럼 탭을 입력으로 넘기지 않는다 — 검토 R1 G1-24). 자리 글자는 웹 placeholder:text-muk-soft/70.
// error: 웹은 required 빈 값에 브라우저 말풍선을 띄운다 — 앱은 칸 아래 한 줄 + 금 테두리로 대신한다(G1-28).
import type { LucideIcon } from 'lucide-react-native';
import { forwardRef, useState } from 'react';
import { TextInput, View, type TextInputProps } from 'react-native';

import { cn, Icon, Text } from '~/components/ui';
import { colors, fontFamilies } from '~/lib/theme/tokens';

export type AuthTextFieldProps = Omit<TextInputProps, 'style' | 'placeholderTextColor'> & {
  icon: LucideIcon;
  /** 화면에 보이는 자리 글자이자 읽기 화면 라벨. */
  label: string;
  /** 칸 아래 안내(빈 값 등). 있으면 테두리를 금색으로. */
  error?: string | null;
};

const PLACEHOLDER = 'rgba(107, 93, 79, 0.7)';

export const AuthTextField = forwardRef<TextInput, AuthTextFieldProps>(function AuthTextField(
  { icon, label, error, onFocus, onBlur, ...rest },
  ref,
) {
  const [focused, setFocused] = useState(false);
  const field = (
    <View
      className={cn(
        'min-h-[50px] flex-row items-center gap-[8px] rounded-xl border bg-white px-[14px]',
        focused || error ? 'border-gold' : 'border-line',
      )}
    >
      <Icon icon={icon} size={18} color="muk-soft" />
      <TextInput
        ref={ref}
        accessibilityLabel={label}
        accessibilityHint={error ?? undefined}
        placeholder={label}
        placeholderTextColor={PLACEHOLDER}
        maxFontSizeMultiplier={1.6}
        style={{
          flex: 1,
          minHeight: 48,
          paddingVertical: 0,
          color: colors.muk,
          fontFamily: fontFamilies.regular,
          fontSize: 16,
        }}
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
  // 안내가 생겨도 입력 칸이 다시 마운트되지 않게(포커스 유지) 늘 같은 바깥 View.
  return (
    <View>
      {field}
      {error ? (
        <Text className="ml-[4px] mt-[4px] text-xs text-dan-red" accessibilityLiveRegion="polite" accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
});
