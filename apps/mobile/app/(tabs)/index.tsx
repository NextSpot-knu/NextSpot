import { TabPlaceholder } from '~/components/TabPlaceholder';
import { useT } from '~/lib/i18n/I18nProvider';

export default function HomeScreen() {
  const t = useT();
  return <TabPlaceholder title={t('nav.home')} />;
}
