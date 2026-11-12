// 서비스 소개 안에서 '어디로 가나' — 소개 모달(GuideModal)과 /guide 화면이 같이 쓴다.
//
// 웹 원본: apps/web/components/guide/GuideContent.tsx(주 행동 = /setup 링크), FeatureShortcuts.tsx(1~4번 = /main).
// 앱은 첫 실행 게이트가 있어 웹처럼 /setup·/ 로 바로 보내면 게이트가 소개로 되돌린다. 그래서:
//   · 첫 실행 '소개' 단계면 소개를 지난 것으로 적는다(markIntroSeen) — 소개 화면이 구독으로 다음 단계(위치 동의)를 그린다.
//   · 그 밖의 첫 실행 단계(설정 화면의 '뒤로' 랜딩에서 연 경우)면 남은 단계 화면으로 replace.
//   · 첫 실행이 끝났으면 웹과 같다 — 주 행동은 /setup(취향 다시 고르기), 바로가기는 홈.
import { router, type Href } from 'expo-router';

import { getFirstRunStep, markIntroSeen, nextFirstRunRoute, noteFirstRunNavigation } from './firstRun';

/** 첫 실행 중이면 다음 단계로 넘긴다. 넘겼으면 true. */
function continueFirstRun(): boolean {
  const step = getFirstRunStep();
  if (!step) return false;
  if (step === 'intro') {
    markIntroSeen();
    return true;
  }
  const route = nextFirstRunRoute();
  noteFirstRunNavigation(route);
  router.replace(route as Href);
  return true;
}

/** 소개 주 행동 '기다림 없는 다음 장소 찾기'(웹 → /setup). */
export function startFromGuide(): void {
  if (continueFirstRun()) return;
  router.push('/setup' as Href);
}

/** 바로가기 '대안 추천 카드'·'실시간 관광정보'(웹 → /main) — 앱 홈. */
export function goHomeFromGuide(): void {
  if (continueFirstRun()) return;
  router.navigate('/' as Href);
}
