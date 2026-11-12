// 언어 스위처(웹 components/LanguageSwitcher.tsx) — 흰 알약 + 지구본 + 현재 언어 + ▾. 고르면 바로 바뀐다.
// 웹처럼 불투명 바탕(지도 위에 떠도 글자가 비치지 않게). 열기는 SelectField(네이티브 가운데 목록 · 웹 빌드 <select>).
import { Globe } from 'lucide-react-native';

import { LOCALES, type Locale } from '@/lib/i18n/config';
import { Icon } from '~/components/ui/Icon';
import { SelectField } from '~/components/ui/SelectField';
import { useI18n } from '~/lib/i18n/I18nProvider';

const OPTIONS = LOCALES.map((l) => ({ value: l.code, label: l.label }));

export function LanguageSwitcher({ className }: { className?: string }) {
  const { locale, setLocale, t } = useI18n();
  return (
    <SelectField<Locale>
      variant="pill"
      value={locale}
      options={OPTIONS}
      onChange={setLocale}
      accessibilityLabel={t('common.languageSelect')}
      leading={<Icon icon={Globe} size={16} color="muk-soft" />}
      className={className}
    />
  );
}
