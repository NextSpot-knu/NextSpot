// '서비스 소개' 여는 입구 하나 — 탭 막대 안내 줄(웹 BottomNav GuideButton compact)·랜딩 '서비스 소개'·데이터 출처 줄이 부른다.
//
// 웹은 GuideProvider 가 소개 <dialog> 를 연다(apps/web/components/guide/GuideProvider.tsx). 앱은 GuideProvider
// (features/onboarding/GuideProvider.tsx, app/_layout.tsx 에 한 번)가 registerGuideOpener() 로 여는 함수를 등록하고,
// openGuide()·openGuideData() 가 그것을 부른다. 등록 전(루트가 아직 안 그려짐)에는 /guide 화면으로 보낸다.
import { router, type Href } from 'expo-router';

/** 소개를 열 때 펼쳐 둘 절 — 'data' 면 '데이터' 절을 펼치고 그 자리로 스크롤한다(웹 requestGuideDataSection). */
export type GuideFocus = 'data';

type GuideOpener = (focus: GuideFocus | null) => void;

let opener: GuideOpener | null = null;

/** 소개를 여는 함수를 등록한다. 돌려준 함수로 해제(같은 함수가 아직 등록돼 있을 때만). */
export function registerGuideOpener(fn: GuideOpener): () => void {
  opener = fn;
  return () => {
    if (opener === fn) opener = null;
  };
}

function open(focus: GuideFocus | null): void {
  if (opener) {
    opener(focus);
    return;
  }
  router.push('/guide' as Href);
}

/** 서비스 소개를 연다. onPress 에 그대로 넘겨도 된다(인자를 읽지 않는다). */
export function openGuide(): void {
  open(null);
}

/** 서비스 소개를 '데이터' 절을 펼친 채로 연다 — 랜딩 데이터 출처 줄(웹 app/page.tsx openDataSection). */
export function openGuideData(): void {
  open('data');
}
