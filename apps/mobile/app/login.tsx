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
// 웹 모양 맞춤(docs/parity/findings-G1.md G1-04·20·21·23·24·25, 검토 R1):
//   · 바탕 AuthBackdrop(노을 + 금빛 광원), 내용이 짧으면 세로 가운데(웹 justify-center · pt 72 · pb 40), 오른쪽 위 언어 선택.
//   · 탭 판 그림자 0 2 14 .06 · 탭 40(+hitSlop) · 선택 바탕 button-gold(결정 D2 — 흰 글자 대비) · 입력 50 · 찾기 링크 24(+hitSlop).
//   · 제출 52·16px·rounded-xl·그림자 없음·돌림표 없음, 게스트·구글 46·rounded-xl, 카카오는 웹 노랑(켜질 때).
//   · 바쁠 때 게스트 버튼은 눌린다(웹). 가입 탭 비밀번호 Enter → 닉네임, 닉네임 Enter → 제출.
//   · 첫 실행 중 소개 → 로그인은 push(뒤로 = 랜딩). 로그인 성공·게스트 진행은 소개를 지난 것으로 적고 스택을 비운 뒤
//     replace — 소개가 밑에 남지 않는다(검토 R1 G1-01 (b)).
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { Lock, Mail, User } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, View, type TextInput } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LanguageSwitcher } from '~/components/LanguageSwitcher';
import { Button, Pressable, Screen, Text, cn, toast } from '~/components/ui';
import { AuthBackdrop } from '~/features/auth/AuthBackdrop';
import { AuthTextField } from '~/features/auth/AuthTextField';
import { signInWithEmail, signUpWithEmail, type SignInFailReason } from '~/features/auth/authService';
import { runOAuthSession } from '~/features/auth/oauthSession';
import { decidePostLoginDest, DEFAULT_LOGIN_DEST, SIGNUP_DEST, safeAppNext } from '~/features/auth/postLoginDest';
import { AUTH_CALLBACK_ROUTE } from '~/features/auth/redirect';
import { socialProvidersFor, type OAuthProvider } from '~/features/auth/socialPolicy';
import { getFirstRunStep, nextFirstRunRoute } from '~/features/onboarding/firstRun';
import { leaveAuthTo } from '~/features/onboarding/firstRunExit';
import { createPublicClient } from '~/lib/core/supabase';
import { syncSaved } from '~/lib/core/savedFacilities';
import { reconcileUserData } from '~/lib/core/userData';
import { useT } from '~/lib/i18n/I18nProvider';
import { shadows } from '~/lib/theme/tokens';

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
  const nicknameRef = useRef<TextInput>(null);
  const insets = useSafeAreaInsets();
  // 이 화면을 떠났는가(게스트로 진행했거나 화면이 사라졌다) — 게스트 버튼은 로그인 대기 중에도 눌리므로(웹과 같다),
  // 늦게 끝난 로그인·OAuth 결과가 사용자가 고른 게스트 흐름을 덮어 이동하지 않게 막는다(검토 M2).
  const leftRef = useRef(false);
  useEffect(
    () => () => {
      leftRef.current = true;
    },
    [],
  );

  // 인증 성공 후: 세션 uid 로 이전(게스트) 로컬 데이터를 격리하고 이 계정의 저장 목록을 받은 뒤 이동.
  // 데이터 맞추기는 떠난 뒤에도 한다(세션은 이미 바뀌었다) — 이동만 하지 않는다.
  // replace — 뒤로 가기가 빈 로그인 폼으로 돌아오지 않게(웹과 같다). 첫 실행 중이면 스택을 비우고 남은 단계로(firstRunExit).
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
    if (leftRef.current) return;
    leaveAuthTo(decidePostLoginDest(rawNext, fallback));
  };

  const handleOAuth = async (provider: OAuthProvider) => {
    if (busy) return;
    setBusy(true);
    const result = await runOAuthSession(provider, safeAppNext(rawNext, DEFAULT_LOGIN_DEST));
    if (leftRef.current) return;
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
          if (leftRef.current) return; // 이미 게스트로 떠났다 — 다른 화면에 로그인 오류를 띄우지 않는다
          toast.error(t(SIGN_IN_ERROR_KEY[reason ?? 'unknown']));
          setBusy(false);
          return;
        }
        await afterAuth(DEFAULT_LOGIN_DEST);
      } else {
        const { error, reason, needsConfirmation } = await signUpWithEmail(trimmed, password, nickname);
        if (leftRef.current && (error || needsConfirmation)) return;
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
      if (leftRef.current) return;
      toast.error(t(mode === 'login' ? 'common.error' : 'login.signupError'));
      setBusy(false);
    }
  };

  // 게스트로 둘러보기 — 익명 세션 그대로. 첫 실행 단계(소개·동의·설정)가 남았으면 그 화면으로, 아니면 온 곳(홈).
  // 바쁠 때도 누를 수 있다(웹 — 로그인 대기 중에도 게스트로 빠질 수 있다).
  const continueAsGuest = () => {
    // 떠났다고 먼저 적는다 — 대기 중인 로그인이 늦게 끝나도 이동하지 않는다(M2).
    leftRef.current = true;
    if (getFirstRunStep() !== null) {
      // 첫 실행 중: 소개를 지나 스택을 비우고 남은 단계로(소개가 밑에 있으면 소개가 다음 단계를 그린다).
      leaveAuthTo(nextFirstRunRoute());
      return;
    }
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace(nextFirstRunRoute() as Href);
  };

  return (
    <KeyboardAvoidingView className="flex-1 bg-hanji" behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <AuthBackdrop glow />
      <Screen scroll className="bg-transparent" contentClassName="justify-center px-[24px] pb-[40px] pt-[72px]">
        <View className="w-full max-w-[380px] self-center">
          <Text className="mb-[4px] text-center text-[30px] leading-[36px] text-muk" weight="bold" accessibilityRole="header">
            {t('common.appName')}
          </Text>
          <Text className="mb-[32px] text-center text-sm text-muk-soft">{t('login.subtitle')}</Text>

          {/* 로그인/회원가입 탭 */}
          <View
            className="mb-[20px] flex-row rounded-2xl border border-line bg-white p-[4px]"
            accessibilityRole="tablist"
            style={{ boxShadow: shadows.card }}
          >
            {(['login', 'signup'] as Mode[]).map((m) => (
              <Pressable
                key={m}
                accessibilityRole="tab"
                accessibilityState={{ selected: mode === m }}
                onPress={() => setMode(m)}
                hitSlop={{ top: 2, bottom: 2 }}
                className={cn(
                  'min-h-[40px] flex-1 items-center justify-center rounded-xl py-[10px]',
                  mode === m ? 'bg-button-gold' : 'bg-white',
                )}
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
              onSubmitEditing={mode === 'login' ? () => void handleSubmit() : () => nicknameRef.current?.focus()}
            />
            {mode === 'signup' && (
              <>
                <AuthTextField
                  ref={nicknameRef}
                  icon={User}
                  label={t('login.nickname')}
                  value={nickname}
                  onChangeText={setNickname}
                  maxLength={20}
                  autoComplete="nickname"
                  textContentType="nickname"
                  returnKeyType="go"
                  onSubmitEditing={() => void handleSubmit()}
                />
                <Text className="-mt-[4px] ml-[4px] text-xs text-muk-soft">{t('login.passwordHint')}</Text>
              </>
            )}

            <Button
              className="mt-[8px]"
              block
              size={52}
              labelSize={16}
              shape="xl"
              shadow="none"
              showSpinner={false}
              label={t(mode === 'login' ? 'login.submitLogin' : 'login.submitSignup')}
              loading={busy}
              onPress={() => void handleSubmit()}
            />
            {mode === 'login' && (
              <Pressable
                accessibilityRole="button"
                onPress={() => router.push('/forgot-password' as Href)}
                hitSlop={{ top: 10, bottom: 10 }}
                className="min-h-[24px] justify-center self-end px-[4px]"
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
                {providers.map((provider) =>
                  provider === 'kakao' ? (
                    // 카카오 — 웹 bg-[#FEE500] text-[#191600] py-3 rounded-xl 14px bold(44).
                    <Pressable
                      key={provider}
                      accessibilityRole="button"
                      accessibilityState={{ disabled: busy }}
                      disabled={busy}
                      onPress={() => void handleOAuth(provider)}
                      className="min-h-[44px] items-center justify-center rounded-xl bg-kakao-yellow py-[12px]"
                      style={busy ? { opacity: 0.5 } : undefined}
                    >
                      <Text className="text-sm text-kakao-ink" weight="bold">
                        {t(PROVIDER_LABEL_KEY[provider])}
                      </Text>
                    </Pressable>
                  ) : (
                    <Button
                      key={provider}
                      variant="secondary"
                      block
                      size={46}
                      shape="xl"
                      disabled={busy}
                      label={t(PROVIDER_LABEL_KEY[provider])}
                      onPress={() => void handleOAuth(provider)}
                    />
                  ),
                )}
              </View>
            </>
          )}
          {mode === 'login' && Platform.OS === 'ios' && (
            <Text className="mt-[16px] text-center text-xs leading-[18px] text-muk-soft">{t('app.auth.iosSocialNote')}</Text>
          )}

          {/* 게스트 둘러보기 — 관광객 무마찰. 각주가 아니라 실제 버튼으로 둔다(웹과 같다). */}
          <View className="mt-[20px] border-t border-line pt-[20px]">
            <Button variant="secondary" block size={46} shape="xl" label={t('login.guest')} onPress={continueAsGuest} />
            <Text className="mt-[8px] text-center text-xs text-muk-soft">{t('login.guestHint')}</Text>
          </View>
        </View>
      </Screen>
      {/* 언어 선택 — 오른쪽 위(웹 absolute top-4 right-4 z-20). */}
      <View className="absolute right-[16px]" style={{ top: insets.top + 16 }}>
        <LanguageSwitcher />
      </View>
    </KeyboardAvoidingView>
  );
}
