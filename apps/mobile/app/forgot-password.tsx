// 비밀번호 재설정 메일 요청 — 메일만 보낸다. 새 비밀번호는 메일 링크를 연 **웹**에서 정한다.
//
// 웹 원본: apps/web/app/forgot-password/page.tsx (기준 커밋 0d145a1)
// 바꾼 것: 앱에는 /auth/reset-password 화면이 없다(계획 §7.2 H4 — 웹 /auth/confirm 은 별도 작업). 보낸 뒤 안내에
// '링크는 웹 브라우저에서 열려요' 를 덧붙인다. 빈 값은 브라우저 required 대신 문구 하나로 막는다. CAPTCHA 없음.
import { useRouter, type Href } from 'expo-router';
import { ArrowLeft, Mail } from 'lucide-react-native';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';

import { Button, IconButton, Screen, Text, toast } from '~/components/ui';
import { AuthTextField } from '~/features/auth/AuthTextField';
import { requestPasswordReset } from '~/features/auth/authService';
import { useT } from '~/lib/i18n/I18nProvider';

export default function ForgotPasswordScreen() {
  const router = useRouter();
  const t = useT();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const back = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/login' as Href);
  };

  const submit = async () => {
    if (busy) return;
    const trimmed = email.trim();
    if (!trimmed) {
      toast.error(t('login.needFields'));
      return;
    }
    setBusy(true);
    try {
      const { error } = await requestPasswordReset(trimmed);
      if (error) {
        toast.error(t('password.requestFailed'));
        return;
      }
      setSent(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView className="flex-1 bg-hanji" behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen scroll contentClassName="px-[24px] py-[32px]">
        <View className="w-full max-w-[380px] self-center">
          <IconButton
            icon={ArrowLeft}
            accessibilityLabel={t('common.back')}
            onPress={back}
            className="mb-[32px] rounded-xl border border-line bg-white"
            box={44}
            color="muk-soft"
          />
          <Text className="text-2xl text-muk" weight="bold" accessibilityRole="header">
            {t('password.requestTitle')}
          </Text>
          <Text className="mb-[28px] mt-[8px] text-sm text-muk-soft">{t('password.requestDesc')}</Text>
          {sent ? (
            <View className="gap-[12px]">
              <View className="rounded-2xl border border-jade/30 bg-jade/10 p-[20px]" accessibilityLiveRegion="polite">
                <Text className="text-sm leading-[22px] text-muk">{t('password.requestSent')}</Text>
                <Text className="mt-[8px] text-sm leading-[22px] text-muk">{t('app.auth.resetOpensOnWeb')}</Text>
              </View>
              <Button variant="secondary" block label={t('login.tabLogin')} onPress={() => router.replace('/login' as Href)} />
            </View>
          ) : (
            <View className="gap-[12px]">
              <AuthTextField
                icon={Mail}
                label={t('login.email')}
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                textContentType="emailAddress"
                returnKeyType="send"
                onSubmitEditing={() => void submit()}
              />
              <Text className="ml-[4px] text-xs leading-[18px] text-muk-soft">{t('app.auth.resetOpensOnWeb')}</Text>
              <Button block label={t('password.requestSubmit')} loading={busy} onPress={() => void submit()} />
            </View>
          )}
        </View>
      </Screen>
    </KeyboardAvoidingView>
  );
}
