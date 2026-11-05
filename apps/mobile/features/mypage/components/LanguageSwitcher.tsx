// 언어 바꾸기 — 웹 components/LanguageSwitcher.tsx(select)를 칩 줄로. 고르면 즉시 반영·저장(useLocale).
import { View } from 'react-native';

import { Chip } from '~/components/ui';
import { LOCALES } from '@/lib/i18n/config';
import { useLocale } from '~/lib/i18n/I18nProvider';

export function LanguageSwitcher() {
  const [locale, setLocale] = useLocale();
  return (
    <View className="flex-row flex-wrap gap-[8px]" accessibilityRole="radiogroup">
      {LOCALES.map((l) => (
        <Chip
          key={l.code}
          label={l.label}
          selected={locale === l.code}
          onPress={() => setLocale(l.code)}
          accessibilityState={{ selected: locale === l.code }}
          className="min-h-[44px] justify-center px-[16px]"
        />
      ))}
    </View>
  );
}
