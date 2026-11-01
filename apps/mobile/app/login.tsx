// 로그인 · 회원가입 · 게스트로 둘러보기.
//
// 웹 원본: apps/web/app/login/page.tsx (기준 커밋 0d145a1)
// 바꾼 것:
//   · 공모전 심사용 계정 안내·채우기(JudgeAccountHint)를 뺐다(대회 종료).
//   · 소셜 버튼은 socialProvidersFor(Platform.OS) 결과만 그린다 — 안드로이드는 구글, iOS 는 없음(App Store 4.8,
//     계획 §7.2 M3), 카카오는 숨김. iOS 에는 소셜 계정은 아직 못 쓴다는 안내를 둔다(계획 §7.2).
//   · 소셜 로그인은 브라우저 왕복(openAuthSessionAsync) 뒤 콜백 라우트로 넘긴다. 여기서는 code 를 교환하지 않는다.
//   · bfcache(pageshow)·8초 안전망이 필요 없다 — openAuthSessionAsync 는 닫히면 반드시 끝난다.
//   · CAPTCHA 없음(계획 §7.6).
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { Lock, Mail, User } from 'lucide-react-native';
import { useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, View, type TextInput } from 'react-native';

import { Button, Pressable, Screen, Text, cn, toast } from '~/components/ui';
import { AuthTextField } from '~/features/auth/AuthTextField';
import { signInWithEmail, signUpWithEmail, type SignInFailReason } from '~/features/auth/authService';
import { runOAuthSession } from '~/features/auth/oauthSession';
import { decidePostLoginDest, DEFAULT_LOGIN_DEST, SIGNUP_DEST, safeAppNext } from '~/features/auth/postLoginDest';
import { AUTH_CALLBACK_ROUTE } from '~/features/auth/redirect';
import { socialProvidersFor, type OAuthProvider } from '~/features/auth/socialPolicy';
import { nextFirstRunRoute } from '~/features/onboarding/firstRun';
import { createPublicClient } from '~/lib/core/supabase';
import { syncSaved } from '~/lib/core/savedFacilities';
import { reconcileUserData } from '~/lib/core/userData';
import { useT } from '~/lib/i18n/I18nProvider';

type Mode = 'login' | 'signup';

// 로그인 실패 원인 → 문구 키(웹과 같다). '서버 장애' 를 '비밀번호가 틀렸다' 로 말하지 않는다.
const SIGN_IN_ERROR_KEY: Record<SignInFailReason, string> = {
  invalid_credentials: 'login.loginError',
  email_not_confirmed: 'login.confirmSent',
  server: 'common.error',
  captcha: 'login.captchaFailed',
  unknown: 'login.loginError',
};

const PROVIDER_LABEL_KEY: Record<OAuthProvider, string> = {
  google: 'auth.continueGoogle',
  kakao: 'auth.continueKakao',
};

export default function LoginScreen() {
  const router = useRouter();
  const t = useT();
  const params = useLocalSearchParams<{ next?: string }>();
  // 화면 파라미터 next 는 앱 경로 목록으로만 받는다(postLoginDest.safeAppNext).
  const rawNext = typeof params.next === 'string' && params.next !== '' ? params.next : null;
  const providers = socialProvidersFor(Platform.OS);

  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [busy, setBusy] = useState(false);
  const passwordRef = useRef<TextInput>(null);

  // 인증 성공 후: 세션 uid 로 이전(게스트) 로컬 데이터를 격리하고 이 계정의 저장 목록을 받은 뒤 이동.
  // replace — 뒤로 가기가 빈 로그인 폼으로 돌아오지 않게(웹과 같다).
  const afterAuth = async (fallback: string) => {
    try {
      const {
        data: { user },
      } = await createPublicClient().auth.getUser();
      reconcileUserData(user?.id ?? null);
      await syncSaved();
    } catch {
      /* 무시 — 이동은 계속 */
    }
    router.replace(decidePostLoginDest(rawNext, fallback) as Href);
  };

  const handleOAuth = async (provider: OAuthProvider) => {
    if (busy) return;
    setBusy(true);
    const result = await runOAuthSession(provider, safeAppNext(rawNext, DEFAULT_LOGIN_DEST));
    if (result.status === 'delivered') {
      // 교환·합치기·이동은 콜백 라우트 한 곳이 한다.
      router.replace(AUTH_CALLBACK_ROUTE as Href);
      return;
    }
    setBusy(false);
    if (result.status === 'error') {
      console.warn('[login] 소셜 로그인 시작 실패:', result.error);
      toast.error(t('auth.linkError'));
    }
  };

  const handleSubmit = async () => {
    if (busy) return;
    const trimmed = email.trim();
    if (!trimmed || !password) {
      toast.error(t('login.needFields'));
      return;
    }
    setBusy(true);
    try {
      if (mode === 'login') {
        const { error, reason } = await signInWithEmail(trimmed, password);
        if (error) {
          toast.error(t(SIGN_IN_ERROR_KEY[reason ?? 'unknown']));
          setBusy(false);
          return;
        }
        await afterAuth(DEFAULT_LOGIN_DEST);
      } else {
        const { error, reason, needsConfirmation } = await signUpWithEmail(trimmed, password, nickname);
        if (error) {
          if (reason === 'email_exists') {
            toast.error(t('login.signupEmailExists'));
            setMode('login');
          } else if (reason === 'weak_password') {
            toast.error(t('login.signupWeakPassword'));
          } else if (reason === 'captcha') {
            toast.error(t('login.captchaFailed'));
          } else {
            toast.error(t('login.signupError'));
          }
          setBusy(false);
          return;
        }
        if (needsConfirmation) {
          toast.success(t('login.confirmSent'));
          setMode('login');
          setBusy(false);
          return;
        }
        await afterAuth(SIGNUP_DEST);
      }
    } catch {
      toast.error(t(mode === 'login' ? 'common.error' : 'login.signupError'));
      setBusy(false);
    }
  };

  // 게스트로 둘러보기 — 익명 세션 그대로. 첫 실행 단계(소개·동의·설정)가 남았으면 그 화면으로, 아니면 홈.
  const continueAsGuest = () => {
    if (busy) return;
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace(nextFirstRunRoute() as Href);
  };

  return (
    <KeyboardAvoidingView className="flex-1 bg-hanji" behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen scroll contentClassName="px-[24px] pb-[40px] pt-[48px]">
        <View className="w-full max-w-[380px] self-center">
          <Text className="mb-[4px] text-center text-[30px] text-muk" weight="bold">
            {t('common.appName')}
          </Text>
          <Text className="mb-[32px] text-center text-sm text-muk-soft">{t('login.subtitle')}</Text>

          {/* 로그인/회원가입 탭 */}
          <View
            className="mb-[20px] flex-row rounded-2xl border border-line bg-white p-[4px]"
            accessibilityRole="tablist"
          >
            {(['login', 'signup'] as Mode[]).map((m) => (
              <Pressable
                key={m}
                accessibilityRole="tab"
                accessibilityState={{ selected: mode === m }}
                onPress={() => setMode(m)}
                className={cn('min-h-[44px] flex-1 items-center justify-center rounded-xl', mode === m ? 'bg-gold' : 'bg-white')}
              >
                <Text className={cn('text-sm', mode === m ? 'text-white' : 'text-muk-soft')} weight="bold">
                  {t(m === 'login' ? 'login.tabLogin' : 'login.tabSignup')}
                </Text>
              </Pressable>
            ))}
          </View>

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
              textContentType="username"
              returnKeyType="next"
              onSubmitEditing={() => passwordRef.current?.focus()}
            />
            <AuthTextField
              ref={passwordRef}
              icon={Lock}
              label={t('login.password')}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              textContentType={mode === 'login' ? 'password' : 'newPassword'}
              returnKeyType={mode === 'login' ? 'go' : 'next'}
              onSubmitEditing={mode === 'login' ? () => void handleSubmit() : undefined}
            />
            {mode === 'signup' && (
              <>
                <AuthTextField
                  icon={User}
                  label={t('login.nickname')}
                  value={nickname}
                  onChangeText={setNickname}
                  maxLength={20}
                  autoComplete="nickname"
                  textContentType="nickname"
                />
                <Text className="-mt-[4px] ml-[4px] text-xs text-muk-soft">{t('login.passwordHint')}</Text>
              </>
            )}

            <Button
              className="mt-[8px]"
              block
              label={t(mode === 'login' ? 'login.submitLogin' : 'login.submitSignup')}
              loading={busy}
              onPress={() => void handleSubmit()}
            />
            {mode === 'login' && (
              <Pressable
                accessibilityRole="button"
                onPress={() => router.push('/forgot-password' as Href)}
                className="min-h-[44px] justify-center self-end px-[4px]"
              >
                <Text className="text-xs text-muk-soft underline">{t('password.forgot')}</Text>
              </Pressable>
            )}
          </View>

          {/* 소셜 로그인 — 로그인 탭에만, 이 플랫폼에서 허용된 공급자만(iOS 는 빈 목록). */}
          {mode === 'login' && providers.length > 0 && (
            <>
              <View className="my-[20px] flex-row items-center gap-[12px]">
                <View className="h-px flex-1 bg-line" />
                <Text className="text-xs text-muk-soft">{t('login.or')}</Text>
                <View className="h-px flex-1 bg-line" />
              </View>
              <View className="gap-[8px]">
                {providers.map((provider) => (
                  <Button
                    key={provider}
                    variant="secondary"
                    block
                    disabled={busy}
                    label={t(PROVIDER_LABEL_KEY[provider])}
                    onPress={() => void handleOAuth(provider)}
                  />
                ))}
              </View>
            </>
          )}
          {mode === 'login' && Platform.OS === 'ios' && (
            <Text className="mt-[16px] text-center text-xs leading-[18px] text-muk-soft">{t('app.auth.iosSocialNote')}</Text>
          )}

          {/* 게스트 둘러보기 — 관광객 무마찰. 각주가 아니라 실제 버튼으로 둔다(웹과 같다). */}
          <View className="mt-[20px] border-t border-line pt-[20px]">
            <Button variant="secondary" block label={t('login.guest')} disabled={busy} onPress={continueAsGuest} />
            <Text className="mt-[8px] text-center text-xs text-muk-soft">{t('login.guestHint')}</Text>
          </View>
        </View>
      </Screen>
    </KeyboardAvoidingView>
  );
}
