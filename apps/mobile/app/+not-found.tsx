import { router, Stack } from 'expo-router';

import { EmptyState, Screen } from '~/components/ui';
import { useT } from '~/lib/i18n/I18nProvider';

// 없는 경로(잘못된 딥링크 등) — 웹 app/not-found.tsx 와 같은 문구.
export default function NotFoundScreen() {
  const t = useT();
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <Screen className="flex-1 justify-center bg-hanji">
        <EmptyState
          title={t('notFound.title')}
          description={t('notFound.body')}
          action={{ label: t('notFound.backToMap'), onPress: () => router.replace('/') }}
        />
      </Screen>
    </>
  );
}
