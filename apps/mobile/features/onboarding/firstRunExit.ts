// 로그인 쪽 화면(로그인·OAuth 복귀)을 떠날 때의 이동 — 로그인 성공·게스트 진행·OAuth 복귀가 같이 쓴다.
// 규칙은 순수 함수 decideFirstRunExit(firstRunCore — 테스트 firstRun.test.ts).
//   첫 실행 '소개' 단계에서 왔으면 소개를 지난 것으로 적고, 첫 실행 중이면 쌓인 스택(소개 랜딩 위의 로그인·콜백)을 비운 뒤
//   남은 단계로 — 첫 실행이 끝났으면 목적지로. 첫 실행이 아니면 스택을 비우지 않는다(검토 M1·L3).
import { router, type Href } from 'expo-router';

import { decideFirstRunExit } from './firstRunCore';
import { getFirstRunStep, markIntroSeen, noteFirstRunNavigation } from './firstRun';

export function leaveAuthTo(dest: string): void {
  const before = getFirstRunStep();
  if (before === 'intro') markIntroSeen();
  const plan = decideFirstRunExit(before, getFirstRunStep(), dest, router.canDismiss());
  if (plan.dismiss) router.dismissAll();
  if (!plan.replaceTo) return;
  if (before !== null) noteFirstRunNavigation(plan.replaceTo);
  router.replace(plan.replaceTo as Href);
}
