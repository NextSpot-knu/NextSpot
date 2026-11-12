// 웹 빌드의 SelectField — 닫힌 상자 위에 진짜 <select> 를 투명하게 겹친다(웹과 같은 값·같은 목록, 키보드·스크린리더 기본 동작).
// 네이티브는 SelectField.tsx(가운데 목록).
import { useState } from 'react';
import { View } from 'react-native';

import { SelectBox, labelOf, type SelectFieldProps } from './selectFieldShared';

export type { SelectFieldProps, SelectOption, SelectVariant } from './selectFieldShared';

export function SelectField<T extends string = string>({
  variant,
  value,
  options,
  onChange,
  accessibilityLabel,
  leading,
  label,
  className,
  style,
  testID,
}: SelectFieldProps<T>) {
  const [focused, setFocused] = useState(false);
  return (
    <View className={className} style={[{ position: 'relative', alignSelf: variant === 'field' ? 'stretch' : 'flex-start' }, style]}>
      <SelectBox
        variant={variant}
        leading={leading}
        label={label}
        valueLabel={labelOf(options, value)}
        focused={focused}
      />
      <select
        data-testid={testID}
        aria-label={accessibilityLabel}
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        onFocus={(e) => setFocused(e.currentTarget.matches(':focus-visible'))}
        onBlur={() => setFocused(false)}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          opacity: 0,
          cursor: 'pointer',
          // 16px 미만이면 iOS Safari 가 초점 때 화면을 확대한다.
          fontSize: 16,
          border: 0,
          appearance: 'none',
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </View>
  );
}
