// 첫 화면(랜딩) + 위치정보 이용 동의 — 첫 실행 게이트(features/onboarding/FirstRunGate)가 보내는 화면.
//
// 웹 원본: apps/web/app/page.tsx(폰 첫 화면 + 첫 방문 소개 모달 자동 열기) (기준 커밋 0d145a1)
// 한 화면이 상황에 맞춰 하나를 그린다(분기 순서는 검토 R1 '서비스 소개 진입'):
//   1. `?view=landing` — 설정 화면의 '뒤로'(첫 실행 중 돌아갈 곳이 없을 때). 단계와 상관없이 랜딩, '바로 시작' → 남은 단계.
//   2. `?step=consent`(LOCATION_CONSENT_ROUTE — 설정의 위치정보 동의 줄) — 첫 실행이 끝난 뒤 동의만 다시 열고 온 곳으로.
//   3. 첫 실행 '동의' 단계 — LocationConsentView(법적 동의라 앱에만 있다 — 결정 D3 A+①, 모양만 맞춤 G1-14).
//   4. 첫 실행 '소개' 단계 — 웹 랜딩(LandingHero). 0.9초 뒤 서비스 소개 모달을 한 번 연다(실행당 1회, G1-03).
//      화면 빈 곳을 눌러도 '바로 시작'(웹 onRootTap). '로그인 / 회원가입' 은 push — 로그인에서 뒤로 = 랜딩(G1-01, R1).
//   5. 첫 실행이 끝난 뒤 주소로 열면 — 소개 모달을 열고 홈으로(웹에는 '닫기 모드' 가 없다, G1-08 4번).
import { useFocusEffect, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LanguageSwitcher } from '~/components/LanguageSwitcher';
import { Pressable, Screen } from '~/components/ui';
import {
  getFirstRunStep,
  markIntroSeen,
  nextFirstRunRoute,
  noteFirstRunNavigation,
  notifyFirstRunChanged,
  subscribeFirstRun,
  type FirstRunStep,
} from '~/features/onboarding/firstRun';
import { openGuide } from '~/features/onboarding/guideEntry';
import { LandingBackdrop } from '~/features/onboarding/LandingBackdrop';
import { LandingHero } from '~/features/onboarding/LandingHero';
import { LocationConsentView } from '~/features/onboarding/LocationConsentView';

/** 첫 방문 소개 모달 자동 열기 — 이번 실행에 한 번만(웹은 nextspot_intro_seen 으로 한 번. 앱은 그 키가 '소개 단계 끝' 이라 메모리). */
let guideAutoShown = false;

export default function IntroScreen() {
  const router = useRouter();
  const [step, setStep] = useState<FirstRunStep | null>(getFirstRunStep);
  const params = useLocalSearchParams<{ step?: string; view?: string }>();
  const landingView = params.view === 'landing';
  const consentOnly = !landingView && step === null && params.step === 'consent';

  // 단계가 바뀌면 따라간다 — 로그인·동의·소개 모달이 기록을 바꿔도(notifyFirstRunChanged) 낡은 단계를 그리지 않는다.
  useEffect(() => {
    setStep(getFirstRunStep());
    return subscribeFirstRun(setStep);
  }, []);

  const showLanding = landingView || step === 'intro';

  // 첫 방문 — 0.9초 뒤 서비스 소개 모달(웹 app/page.tsx:113-151). 이 화면이 보일 때만(로그인으로 넘어가면 취소 —
  // 웹은 랜딩이 사라져 열리지 않는다).
  useFocusEffect(
    useCallback(() => {
      if (step !== 'intro' || landingView || guideAutoShown) return;
      const id = setTimeout(() => {
        guideAutoShown = true;
        openGuide();
      }, 900);
      return () => clearTimeout(id);
    }, [step, landingView]),
  );

  // 첫 실행이 끝난 뒤 주소로 열었다(처음 그릴 때 이미 끝남) — 소개는 모달로 보이고 이 화면은 홈으로 바꾼다.
  // 처음 그릴 때만 본다 — 이 화면이 스택 밑에 있는 동안 첫 실행이 끝나도(로그인) 여기서 이동하지 않는다.
  const [openedAfterFirstRun] = useState(() => getFirstRunStep() === null && !landingView && params.step !== 'consent');
  useEffect(() => {
    if (!openedAfterFirstRun) return;
    openGuide();
    router.replace('/' as Href);
  }, [openedAfterFirstRun, router]);

  const goNext = () => {
    const route = nextFirstRunRoute();
    const nextStep = getFirstRunStep();
    // 소개 → 동의는 같은 화면 안에서 바꾼다(경로가 같다). 랜딩 보기(?view=landing)는 쿼리를 떼려고 이동한다.
    if (route === '/intro' && nextStep && !landingView) {
      setStep(nextStep);
      return;
    }
    noteFirstRunNavigation(route);
    router.replace(route as Href);
  };

  const start = () => {
    if (getFirstRunStep() === 'intro') markIntroSeen();
    goNext();
  };

  // 로그인은 push — 로그인에서 뒤로 = 이 랜딩(웹 브라우저 뒤로와 같다). 소개를 지난 표식은 로그인 성공·게스트 진행 때
  // 적는다(지금 적으면 이 화면이 구독으로 동의 단계로 바뀌어 '뒤로 = 랜딩' 이 되지 않는다 — 검토 R1 G1-01).
  const toLogin = () => {
    router.push('/login' as Href);
  };

  if (consentOnly) {
    return (
      <Screen scroll contentClassName="px-[20px] pb-[24px] pt-[32px]">
        <LocationConsentView onDone={() => (router.canGoBack() ? router.back() : router.replace('/' as Href))} />
      </Screen>
    );
  }

  if (!showLanding && step === 'consent') {
    return (
      <Screen scroll contentClassName="px-[20px] pb-[24px] pt-[32px]">
        <LocationConsentView
          onDone={() => {
            notifyFirstRunChanged();
            goNext();
          }}
        />
      </Screen>
    );
  }

  // 설정으로 넘어가는 중이거나(구독이 먼저 'setup' 을 알렸다) 끝난 뒤 홈으로 바꾸는 중 — 빈 한지 화면.
  if (!showLanding) return <Screen>{null}</Screen>;

  return <Landing onStart={start} onLogin={toLogin} />;
}

/** 랜딩 화면 틀 — 바탕은 Screen 바깥(고정), 언어 선택은 오른쪽 위, 빈 곳을 눌러도 시작. */
function Landing({ onStart, onLogin }: { onStart: () => void; onLogin: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View className="flex-1 bg-hanji">
      <LandingBackdrop />
      <Screen scroll className="bg-transparent" contentClassName="">
        {/* 웹 루트 onClick(onRootTap) — 랜딩 전체가 '바로 시작'. 읽기 화면에는 버튼 하나로 묶이지 않게 accessible=false
            (안쪽 버튼·링크는 각자 Pressable 이라 부모로 새지 않는다 — 검토 R1 G1-01 (a)). */}
        <Pressable
          noFeedback
          accessible={false}
          onPress={onStart}
          className="flex-1 items-center justify-center px-[24px] pb-[32px] pt-[56px]"
        >
          <LandingHero onStart={onStart} onLogin={onLogin} />
        </Pressable>
      </Screen>
      {/* 언어 선택 — 오른쪽 위(웹 absolute top-4 right-4 z-20). */}
      <View className="absolute right-[16px]" style={{ top: insets.top + 16 }}>
        <LanguageSwitcher />
      </View>
    </View>
  );
}
