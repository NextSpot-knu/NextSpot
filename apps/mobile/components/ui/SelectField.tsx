// 선택 상자(웹 <select> 대체) — 닫힌 상자 + 누르면 가운데 RN Modal 의 라디오 목록(행 48pt).
// Chrome 안드로이드의 select 목록 모양과 같고, RN Modal(소개 모달) 안에서도 따로 Provider 가 필요 없다(계획 §4.3).
// 웹 빌드는 SelectField.web.tsx 가 진짜 <select> 를 투명하게 겹친다. @expo/ui 는 쓰지 않는다.
import { useState } from 'react';
import { Modal, View } from 'react-native';
import { Check } from 'lucide-react-native';

import { GlassToneContext } from './glassContext';
import { useT } from '~/lib/i18n/I18nProvider';
import { colors } from '~/lib/theme/tokens';

import { cn } from './cn';
import { Icon } from './Icon';
import { Pressable } from './Pressable';
import { Text } from './Text';
import { SelectBox, labelOf, type SelectFieldProps, type SelectOption, type SelectVariant } from './selectFieldShared';

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
  const t = useT();
  const [open, setOpen] = useState(false);
  const valueLabel = labelOf(options, value);

  const pick = (next: T) => {
    setOpen(false);
    if (next !== value) onChange(next);
  };

  return (
    <>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityValue={{ text: valueLabel }}
        accessibilityState={{ expanded: open }}
        hitSlop={variant === 'pill' ? { top: 6, bottom: 6, left: 2, right: 2 } : undefined}
        onPress={() => setOpen(true)}
        className={cn(variant === 'field' ? 'self-stretch' : 'self-start', className)}
        style={style}
      >
        <SelectBox variant={variant} leading={leading} label={label} valueLabel={valueLabel} />
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)} statusBarTranslucent>
        <GlassToneContext.Provider value={null}>
        <View className="flex-1 items-center justify-center px-[24px]">
          <Pressable
            noFeedback
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
            onPress={() => setOpen(false)}
            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(43, 35, 32, 0.4)' }}
          />
          <View
            accessibilityViewIsModal
            onAccessibilityEscape={() => setOpen(false)}
            accessibilityRole="radiogroup"
            accessibilityLabel={accessibilityLabel}
            className="w-full max-w-[320px] overflow-hidden rounded-2xl bg-white py-[8px]"
            style={{ boxShadow: '0px 10px 30px rgba(43, 35, 32, 0.18)' }}
          >
            {options.map((o: SelectOption<T>) => {
              const selected = o.value === value;
              return (
                <Pressable
                  key={o.value}
                  noFeedback
                  accessibilityRole="radio"
                  accessibilityLabel={o.label}
                  accessibilityState={{ checked: selected }}
                  onPress={() => pick(o.value)}
                  className="min-h-[48px] flex-row items-center justify-between px-[20px]"
                  style={selected ? { backgroundColor: 'rgba(193, 154, 62, 0.12)' } : undefined}
                >
                  <Text className="text-[16px] text-muk" weight={selected ? 'bold' : 'regular'}>
                    {o.label}
                  </Text>
                  {selected ? <Icon icon={Check} size={18} color={colors['gold-deep']} /> : null}
                </Pressable>
              );
            })}
          </View>
        </View>
        </GlassToneContext.Provider>
      </Modal>
    </>
  );
}
