// 첫 실행 소개 + 위치정보 이용 동의 — 첫 실행 게이트(features/onboarding/FirstRunGate)가 보내는 화면.
//
// 웹 원본: apps/web/app/page.tsx(폰 첫 화면 + 첫 방문 소개 모달 — nextspot_intro_seen), components/guide/* (기준 커밋 0d145a1)
// 한 화면이 첫 실행 단계에 맞춰 둘 중 하나를 그린다:
//   · 소개(step 'intro'): 언어 고르기 · 가치 문장 · 서비스 소개 · '바로 시작'(→ 동의) · '로그인 / 회원가입'.
//   · 동의(step 'consent'): LocationConsentView — '동의' · '동의 안 함'(법적 동의라 두 버튼).
// 첫 실행이 끝난 뒤 열면(예: 마이페이지 '서비스 소개') 소개만 보이고 '닫기'로 돌아간다.
// `/intro?step=consent`(LOCATION_CONSENT_ROUTE — 홈 '동의 없음' 배너 · 설정의 위치정보 동의 줄)는 첫 실행이 끝난 뒤에도
// 동의 단계만 열고, 고르면 온 곳으로 돌아간다. 동의 문구가 약속한 '나중에 설정에서 바꿀 수 있어요'의 입구다.
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Button, Chip, Screen } from '~/components/ui';
import {
  getFirstRunStep,
  markIntroSeen,
  nextFirstRunRoute,
  noteFirstRunNavigation,
  notifyFirstRunChanged,
  subscribeFirstRun,
  type FirstRunStep,
} from '~/features/onboarding/firstRun';
import { GuideHero, GuideSections } from '~/features/onboarding/GuideSections';
import { LocationConsentView } from '~/features/onboarding/LocationConsentView';
import { LOCALES } from '@/lib/i18n/config';
import { useLocale, useT } from '~/lib/i18n/I18nProvider';

export default function IntroScreen() {
  const router = useRouter();
  const t = useT();
  const [locale, setLocale] = useLocale();
  const [step, setStep] = useState<FirstRunStep | null>(getFirstRunStep);
  const params = useLocalSearchParams<{ step?: string }>();
  const consentOnly = step === null && params.step === 'consent';

  // 단계가 바뀌면 따라간다 — 로그인·동의 화면 등 다른 곳이 기록을 바꿔도(notifyFirstRunChanged) 낡은 단계를 그리지 않는다.
  useEffect(() => {
    setStep(getFirstRunStep());
    return subscribeFirstRun(setStep);
  }, []);

  const goNext = () => {
    const route = nextFirstRunRoute();
    const nextStep = getFirstRunStep();
    // 소개 → 동의는 같은 화면 안에서 바꾼다(경로가 같다).
    if (route === '/intro' && nextStep) {
      setStep(nextStep);
      return;
    }
    noteFirstRunNavigation(route);
    router.replace(route as Href);
  };

  const start = () => {
    markIntroSeen();
    goNext();
  };

  // 첫 실행 중의 로그인은 소개를 바꿔치기한다(replace) — push 면 로그인 뒤 탭이 소개 위에 쌓여, 소개가 스택 밑에 남고
  // 탭의 첫 실행 판정이 동의 화면을 하나 더 얹는다. 로그인의 '게스트로 둘러보기' 는 돌아갈 곳이 없으면
  // 남은 첫 실행 단계(동의)로 replace 하므로 흐름이 끊기지 않는다.
  const toLogin = () => {
    markIntroSeen();
    router.replace('/login' as Href);
  };

  if (consentOnly) {
    return (
      <Screen scroll contentClassName="px-[20px] py-[24px]">
        <LocationConsentView
          onDone={() => (router.canGoBack() ? router.back() : router.replace('/' as Href))}
        />
      </Screen>
    );
  }

  if (step === 'consent') {
    return (
      <Screen scroll contentClassName="px-[20px] py-[24px]">
        <LocationConsentView
          onDone={() => {
            notifyFirstRunChanged();
            goNext();
          }}
        />
      </Screen>
    );
  }

  // 소개·동의가 끝나고 설정으로 넘어가는 중(구독이 먼저 'setup' 을 알렸다) — 닫기 버튼 소개를 잠깐 그리지 않는다.
  if (step === 'setup') return <Screen>{null}</Screen>;

  const firstRun = step === 'intro';
  return (
    <Screen scroll contentClassName="px-[20px] pb-[32px] pt-[16px]">
      {/* 언어 — 외국인 관광객이 첫 화면에서 바로 바꾼다(웹 랜딩의 LanguageSwitcher). */}
      <View className="mb-[24px] flex-row flex-wrap justify-end gap-[6px]" accessibilityLabel={t('app.intro.languageLabel')}>
        {LOCALES.map((l) => (
          <Chip key={l.code} label={l.label} selected={locale === l.code} onPress={() => setLocale(l.code)} />
        ))}
      </View>
      <GuideHero />
      <View className="mt-[24px] gap-[10px]">
        {firstRun ? (
          <>
            <Button block label={t('landing.ctaStart')} onPress={start} className="min-h-[52px]" />
            <Button block variant="secondary" label={t('landing.ctaLogin')} onPress={toLogin} />
          </>
        ) : (
          <Button
            block
            variant="secondary"
            label={t('common.close')}
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/' as Href))}
          />
        )}
      </View>
      <View className="mt-[32px]">
        <GuideSections />
      </View>
    </Screen>
  );
}
