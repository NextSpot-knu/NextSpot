// OAuth 복귀 처리 — 앱에서 code 를 교환하는 **유일한** 화면(계획 §7.2).
//
// 웹 원본: apps/web/app/auth/callback/page.tsx (기준 커밋 0d145a1)
// 이 화면은 URL 쿼리를 읽지 않는다. 딥링크 원문은 +native-intent·로그인 화면이 받은편지함(callbackInbox)에 넣고,
// 여기서는 processAuthCallback()(callbackFlow — 한 번만 도는 처리기)에게 맡긴다:
//   진행 중 흐름 확인 → (오류면) identity_already_exists 폴백 한 번 / 실패 → (code 면) 한 번만 교환 →
//   게스트 데이터 합치기 → 프로필 맞추기 → 목적지로 replace.
// 화면이 두 번 붙어도(안드로이드 이중 수신) 처리기는 한 번 돌고 둘 다 같은 결과를 받는다.
// 비밀번호 복구 분기(웹 'recovery')는 없다 — 재설정 메일 링크는 웹에서 끝난다(G1-30 유지).
// 웹 모양(G1-29): 처리 중 40px 금 링(RingSpinner) mb 16, 실패 제목 18/28 · 설명 max 320 · 주 버튼 단색 금 알약
// (button-gold — 결정 D2) 48·16px·px 24 · '로그인' 밑줄 글자. 두 블록 모두 웹 animate-fade-in(fade-in-up 1s).
import { useRouter, type Href } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import Animated from 'react-native-reanimated';

import { Button, Pressable, Screen, Text } from '~/components/ui';
import { RingSpinner } from '~/components/ui/RingSpinner';
import { processAuthCallback, type CallbackFailure } from '~/features/auth/callbackFlow';
import { useFadeInUp } from '~/features/onboarding/useFadeInUp';
import { useT } from '~/lib/i18n/I18nProvider';

export default function AuthCallbackScreen() {
  const router = useRouter();
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
        <Failed reason={failed} onMypage={() => router.replace('/mypage' as Href)} onLogin={() => router.replace('/login' as Href)} />
      ) : (
        <Waiting />
      )}
    </Screen>
  );
}

function Waiting() {
  const t = useT();
  const fade = useFadeInUp();
  return (
    <Animated.View accessibilityLiveRegion="polite" style={[{ alignItems: 'center' }, fade]}>
      <View className="mb-[16px]">
        <RingSpinner size={40} borderWidth={3} />
      </View>
      <Text className="text-sm text-muk-soft">{t('auth.callbackLoading')}</Text>
    </Animated.View>
  );
}

// 실패 화면은 반드시 나갈 길을 준다 — 마이페이지와 로그인 다시 하기.
function Failed({ reason, onMypage, onLogin }: { reason: CallbackFailure; onMypage: () => void; onLogin: () => void }) {
  const t = useT();
  const fade = useFadeInUp();
  const linked = reason === 'already_linked';
  return (
    <Animated.View accessibilityLiveRegion="polite" style={[{ alignItems: 'center' }, fade]}>
      <Text className="mb-[8px] text-center text-lg leading-[28px] text-muk" weight="bold" accessibilityRole="header">
        {t(linked ? 'auth.callbackAlreadyLinkedTitle' : 'auth.callbackFailedTitle')}
      </Text>
      <Text className="mb-[24px] max-w-[320px] text-center text-sm text-muk-soft">
        {t(linked ? 'auth.callbackAlreadyLinkedDesc' : 'auth.callbackFailedDesc')}
      </Text>
      <Button
        variant="gold"
        size={48}
        labelSize={16}
        shape="full"
        paddingX={24}
        label={t('auth.callbackBackToMypage')}
        onPress={onMypage}
      />
      {/* 웹 mt-3 px-4 py-2 text-sm underline(36) — 누르는 자리는 위아래 4 를 더해 44. */}
      <Pressable
        accessibilityRole="button"
        onPress={onLogin}
        hitSlop={{ top: 4, bottom: 4 }}
        className="mt-[12px] min-h-[36px] justify-center px-[16px] py-[8px]"
      >
        <Text className="text-sm text-muk-soft underline">{t('login.tabLogin')}</Text>
      </Pressable>
    </Animated.View>
  );
}
