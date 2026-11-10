// '서비스 소개' 여는 입구 하나 — 탭 막대 안내 줄(웹 BottomNav GuideButton compact)·랜딩 '서비스 소개'·데이터 출처 줄이 부른다.
//
// 웹은 GuideProvider 가 소개 <dialog> 를 연다(apps/web/components/guide/GuideProvider.tsx). 앱은 GuideProvider
// (features/onboarding/GuideProvider.tsx, app/_layout.tsx 에 한 번)가 registerGuideOpener() 로 여는 함수를 등록하고,
// openGuide()·openGuideData() 가 그것을 부른다. 등록 전(첫 그리기에서 화면 효과가 루트보다 먼저 돎)에는 요청을 잡아 두었다가
// 등록되는 즉시 연다(guideOpenQueue — G1-08). 그래도 등록이 오지 않으면 /guide 화면으로 보낸다.
import { router, type Href } from 'expo-router';

import { createGuideOpenQueue, type GuideFocus } from './guideOpenQueue';

export type { GuideFocus } from './guideOpenQueue';

/** 루트 GuideProvider 의 등록을 기다리는 시간 — 보통은 같은 커밋 안에서 온다. */
const REGISTER_WAIT_MS = 1000;

const queue = createGuideOpenQueue({
  fallback: () => router.push('/guide' as Href),
  waitMs: REGISTER_WAIT_MS,
});

/** 소개를 여는 함수를 등록한다. 돌려준 함수로 해제(같은 함수가 아직 등록돼 있을 때만). */
export const registerGuideOpener: (fn: (focus: GuideFocus | null) => void) => () => void = queue.register;

/** 서비스 소개를 연다. onPress 에 그대로 넘겨도 된다(인자를 읽지 않는다). */
export function openGuide(): void {
  queue.open(null);
}

/** 서비스 소개를 '데이터' 절을 펼친 채로 연다 — 랜딩 데이터 출처 줄(웹 app/page.tsx openDataSection). */
export function openGuideData(): void {
  queue.open('data');
}
