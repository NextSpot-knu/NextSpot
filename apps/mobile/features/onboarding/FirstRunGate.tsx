// 첫 실행 게이트 — 소개 → 위치정보 이용 동의 → 첫 설정 → 탭 순서를 지킨다.
//
// 쓰는 법(app/_layout.tsx — 통합 담당이 넣는다):
//   <ThemeProvider value={navTheme}>
//     <Stack>…</Stack>
//     <FirstRunGate />          ← Stack 바로 뒤(같은 ThemeProvider 안). 라우터 훅을 쓰므로 Stack 과 같은 트리 안이어야 한다.
//   </ThemeProvider>
// 게이트는 화면이 아니다. 네비게이터가 준비되면 지금 경로를 보고, 첫 실행 단계가 남았는데 다른 화면이면
// router.replace 로 그 단계 화면으로 보낸다. 보내는 동안에는 한지색 판으로 덮어 탭이 한 번 번쩍이지 않게 한다.
// 로그인·재설정·OAuth 복귀(/login · /forgot-password · /auth/callback)는 첫 실행 중에도 지나가게 둔다.
// 보안 경계가 아니다 — 위치 사용의 경계는 hasLocationConsent()(features/auth/consent)다.
import { usePathname, useRootNavigationState, useRouter, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { readPendingFlow } from '~/features/auth/pendingFlow';
import { colors } from '~/lib/theme/tokens';

import {
  decideFirstRunRedirect,
  getFirstRunStep,
  navigatedRecentlyTo,
  noteFirstRunNavigation,
  subscribeFirstRun,
  type FirstRunStep,
} from './firstRun';

export interface FirstRunGateState {
  /** 남은 첫 실행 단계(없으면 null). */
  step: FirstRunStep | null;
  /** 지금 경로에서 보내야 할 곳(없으면 null). */
  redirectTo: string | null;
  /** 네비게이터가 준비됐는가 — 준비 전에는 이동하지 않는다. */
  navReady: boolean;
}

/** 첫 실행 상태를 읽고 바뀌면 다시 그린다. 이동은 하지 않는다(FirstRunGate 가 한다). */
export function useFirstRunGate(): FirstRunGateState {
  const [step, setStep] = useState<FirstRunStep | null>(getFirstRunStep);
  const pathname = usePathname();
  const navState = useRootNavigationState();
  useEffect(() => subscribeFirstRun(setStep), []);
  // 경로가 바뀔 때마다 저장소를 다시 읽는다(다른 화면이 기록을 바꾸고 알리지 않았을 때를 대비).
  useEffect(() => {
    setStep(getFirstRunStep());
  }, [pathname]);
  // 소셜 로그인 왕복 중(진행 중 흐름 기록이 있음)에는 보내지 않는다 — 콜드 스타트에서 콜백 화면이 첫 URL 을
  // 받기 전에 소개로 바꿔치기하면 code 가 처리되지 않는다. 기록은 끝나거나 취소되면 지워지고 10분이면 만료된다.
  const oauthInFlight = readPendingFlow((globalThis as { localStorage?: Storage }).localStorage ?? null, Date.now()) !== null;
  return {
    step,
    redirectTo: oauthInFlight ? null : decideFirstRunRedirect(step, pathname),
    navReady: Boolean(navState?.key),
  };
}

export function FirstRunGate(): React.ReactElement | null {
  const router = useRouter();
  const { redirectTo, navReady } = useFirstRunGate();

  useEffect(() => {
    if (!navReady || !redirectTo) return;
    if (navigatedRecentlyTo(redirectTo)) return; // 단계 화면이 막 같은 곳으로 보냈다
    noteFirstRunNavigation(redirectTo);
    router.replace(redirectTo as Href);
  }, [navReady, redirectTo, router]);

  if (!redirectTo) return null;
  return <View pointerEvents="auto" style={[StyleSheet.absoluteFill, { backgroundColor: colors.hanji }]} />;
}
