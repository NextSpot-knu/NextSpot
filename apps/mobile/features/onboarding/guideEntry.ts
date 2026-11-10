// '서비스 소개' 여는 입구 하나 — 탭 막대 안내 줄(웹 BottomNav GuideButton compact)·마이 등이 openGuide() 만 부른다.
//
// 웹은 GuideProvider 가 소개 <dialog> 를 연다(apps/web/components/guide/GuideProvider.tsx). 앱의 소개 모달은 D1 이 만든다:
// D1 의 GuideProvider 가 registerGuideOpener() 로 여는 함수를 등록하면 openGuide() 가 그것을 부른다.
// 등록 전(D1 병합 전)에는 지금의 소개 화면 `/intro`(첫 실행이 끝났으면 '닫기' 모드)로 보낸다.
import { router, type Href } from 'expo-router';

type GuideOpener = () => void;

let opener: GuideOpener | null = null;

/** 소개를 여는 함수를 등록한다. 돌려준 함수로 해제(같은 함수가 아직 등록돼 있을 때만). */
export function registerGuideOpener(fn: GuideOpener): () => void {
  opener = fn;
  return () => {
    if (opener === fn) opener = null;
  };
}

/** 서비스 소개를 연다. */
export function openGuide(): void {
  if (opener) {
    opener();
    return;
  }
  router.push('/intro' as Href);
}
