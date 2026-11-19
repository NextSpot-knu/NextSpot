// 비밀번호 재설정 메일 요청 — 메일만 보낸다. 새 비밀번호는 메일 링크를 연 **웹**에서 정한다.
//
// 웹 원본: apps/web/app/forgot-password/page.tsx (기준 커밋 0d145a1)
// 바꾼 것: 앱에는 /auth/reset-password 화면이 없다(계획 §7.2 H4 — 웹 /auth/confirm 은 별도 작업). 보낸 뒤 안내 상자에만
// '링크는 웹 브라우저에서 열려요' 를 덧붙인다(G1-27 A — 첫 화면은 웹과 같게). CAPTCHA 없음.
// 웹 모양(G1-26): 노을 바탕(광원 없음) · 뒤로 42 · 입력 50 · 제출 단색 금(button-gold — 결정 D2) 52·16px·rounded-xl,
// 보내는 중에는 돌림표 대신 글자가 '불러오는 중...'(common.loading). 완료 '로그인' 은 46·rounded-xl 보조 버튼.
// 빈 값: 웹은 브라우저 required 말풍선 — 앱은 칸 아래 한 줄 app.auth.emailRequired(G1-28).
import { useRouter, type Href } from 'expo-router';
import { ArrowLeft, Mail } from 'lucide-react-native';
import { useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, View, type TextInput } from 'react-native';

import { Button, IconButton, Screen, Text, toast } from '~/components/ui';
import { AuthBackdrop } from '~/features/auth/AuthBackdrop';
import { AuthTextField } from '~/features/auth/AuthTextField';
import { requestPasswordReset } from '~/features/auth/authService';
import { useT } from '~/lib/i18n/I18nProvider';

export default function ForgotPasswordScreen() {
  const router = useRouter();
  const t = useT();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [emptyError, setEmptyError] = useState(false);
  const inputRef = useRef<TextInput>(null);

  const back = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/login' as Href);
  };

  const submit = async () => {
    if (busy) return;
    const trimmed = email.trim();
    if (!trimmed) {
      setEmptyError(true);
      inputRef.current?.focus();
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
      <AuthBackdrop />
      <Screen scroll className="bg-transparent" contentClassName="px-[24px] py-[32px]">
        <View className="w-full max-w-[380px] self-center">
          <IconButton
            icon={ArrowLeft}
            accessibilityLabel={t('common.back')}
            onPress={back}
            className="mb-[32px] rounded-xl border border-line bg-white"
            box={42}
            color="muk-soft"
          />
          <Text className="text-2xl text-muk" weight="bold" accessibilityRole="header">
            {t('password.requestTitle')}
          </Text>
          <Text className="mb-[28px] mt-[8px] text-sm text-muk-soft">{t('password.requestDesc')}</Text>
          {sent ? (
            <View className="gap-[12px]">
              <View className="rounded-2xl border border-jade/30 bg-jade/10 p-[20px]" accessibilityLiveRegion="polite">
                <Text className="text-sm leading-[22.75px] text-muk">{t('password.requestSent')}</Text>
                <Text className="mt-[8px] text-sm leading-[22.75px] text-muk">{t('app.auth.resetOpensOnWeb')}</Text>
              </View>
              <Button
                variant="secondary"
                block
                size={46}
                shape="xl"
                label={t('login.tabLogin')}
                onPress={() => router.replace('/login' as Href)}
              />
            </View>
          ) : (
            <View className="gap-[12px]">
              <AuthTextField
                ref={inputRef}
                icon={Mail}
                label={t('login.email')}
                value={email}
                onChangeText={(v) => {
                  setEmail(v);
                  if (emptyError && v.trim()) setEmptyError(false);
                }}
                error={emptyError ? t('app.auth.emailRequired') : null}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                textContentType="emailAddress"
                returnKeyType="send"
                onSubmitEditing={() => void submit()}
              />
              <Button
                variant="gold"
                block
                size={52}
                labelSize={16}
                shape="xl"
                showSpinner={false}
                label={busy ? t('common.loading') : t('password.requestSubmit')}
                loading={busy}
                onPress={() => void submit()}
              />
            </View>
          )}
        </View>
      </Screen>
    </KeyboardAvoidingView>
  );
}
