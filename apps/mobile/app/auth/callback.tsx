// OAuth 복귀 처리 — 앱에서 code 를 교환하는 **유일한** 화면(계획 §7.2).
//
// 웹 원본: apps/web/app/auth/callback/page.tsx (기준 커밋 0d145a1)
// 이 화면은 URL 쿼리를 읽지 않는다. 딥링크 원문은 +native-intent·로그인 화면이 받은편지함(callbackInbox)에 넣고,
// 여기서는 processAuthCallback()(callbackFlow — 한 번만 도는 처리기)에게 맡긴다:
//   진행 중 흐름 확인 → (오류면) identity_already_exists 폴백 한 번 / 실패 → (code 면) 한 번만 교환 →
//   게스트 데이터 합치기 → 프로필 맞추기 → 목적지로 replace.
// 화면이 두 번 붙어도(안드로이드 이중 수신) 처리기는 한 번 돌고 둘 다 같은 결과를 받는다.
// 비밀번호 복구 분기(웹 'recovery')는 없다 — 재설정 메일 링크는 웹에서 끝난다.
import { useRouter, type Href } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { Button, Pressable, Screen, Text } from '~/components/ui';
import { processAuthCallback, type CallbackFailure } from '~/features/auth/callbackFlow';
import { useT } from '~/lib/i18n/I18nProvider';
import { colors } from '~/lib/theme/tokens';

export default function AuthCallbackScreen() {
  const router = useRouter();
  const t = useT();
  const [failed, setFailed] = useState<CallbackFailure | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void processAuthCallback().then((result) => {
      if (!mounted.current) return;
      if (result.kind === 'done') router.replace(result.dest as Href);
      else setFailed(result.reason);
    });
    return () => {
      mounted.current = false;
    };
  }, [router]);

  return (
    <Screen contentClassName="flex-1 items-center justify-center px-[24px]">
      {failed ? (
        // 실패 화면은 반드시 나갈 길을 준다 — 마이페이지와 로그인 다시 하기.
        <View className="items-center" accessibilityLiveRegion="polite">
          <Text className="mb-[8px] text-center text-lg text-muk" weight="bold" accessibilityRole="header">
            {t(failed === 'already_linked' ? 'auth.callbackAlreadyLinkedTitle' : 'auth.callbackFailedTitle')}
          </Text>
          <Text className="mb-[24px] max-w-[320px] text-center text-sm text-muk-soft">
            {t(failed === 'already_linked' ? 'auth.callbackAlreadyLinkedDesc' : 'auth.callbackFailedDesc')}
          </Text>
          <Button label={t('auth.callbackBackToMypage')} onPress={() => router.replace('/mypage' as Href)} />
          <Pressable
            accessibilityRole="button"
            onPress={() => router.replace('/login' as Href)}
            className="mt-[12px] min-h-[44px] justify-center px-[16px]"
          >
            <Text className="text-sm text-muk-soft underline">{t('login.tabLogin')}</Text>
          </Pressable>
        </View>
      ) : (
        <View className="items-center" accessibilityLiveRegion="polite">
          <ActivityIndicator size="large" color={colors.gold} />
          <Text className="mt-[16px] text-sm text-muk-soft">{t('auth.callbackLoading')}</Text>
        </View>
      )}
    </Screen>
  );
}
