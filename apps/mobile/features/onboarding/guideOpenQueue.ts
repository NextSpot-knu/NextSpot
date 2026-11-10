// 서비스 소개 열기 요청을 여는 함수가 등록될 때까지 잡아 두는 순수 모듈 — react-native·expo-router 를 import 하지 않는다
// (guideOpenQueue.test.ts 가 잠근다). guideEntry.ts 가 앱 하나에 한 벌 만든다.
//
// 왜: 첫 실행이 끝난 뒤 `/intro` 로 바로 열면(딥 링크) intro 화면의 마운트 효과가 루트 GuideProvider 의 등록 효과보다 먼저 돈다
// (React 는 자식·앞 형제의 효과를 먼저 돌리고, Stack 은 GuideProvider 보다 앞 형제다). 예전에는 그 순간 등록이 없어 `/guide` 로
// push 했고, 바로 뒤의 replace('/') 가 그것을 덮어 소개 없이 홈만 보였다(G1-08). 이제는 요청을 잡아 두었다가 등록되는 즉시 연다.

/** 소개를 열 때 펼쳐 둘 절 — 'data' 면 '데이터' 절을 펼치고 그 자리로 스크롤한다(웹 requestGuideDataSection). */
export type GuideFocus = 'data';

export type GuideOpener = (focus: GuideFocus | null) => void;

type Timer = ReturnType<typeof setTimeout>;

export type GuideOpenQueueOptions = {
  /** 이 시간 안에 여는 함수가 등록되지 않으면 부른다(루트가 그려지지 않는 드문 경우 — `/guide` 화면으로). */
  fallback: (focus: GuideFocus | null) => void;
  /** 등록을 기다리는 시간(ms). */
  waitMs: number;
  schedule?: (fn: () => void, ms: number) => Timer;
  cancel?: (timer: Timer) => void;
};

export function createGuideOpenQueue({ fallback, waitMs, schedule = setTimeout, cancel = clearTimeout }: GuideOpenQueueOptions) {
  let opener: GuideOpener | null = null;
  let pending: { focus: GuideFocus | null } | null = null;
  let timer: Timer | null = null;

  const clearTimer = () => {
    if (timer !== null) cancel(timer);
    timer = null;
  };

  /** 여는 함수를 등록한다 — 기다리던 요청이 있으면 바로 연다. 돌려준 함수로 해제(같은 함수가 아직 등록돼 있을 때만). */
  function register(fn: GuideOpener): () => void {
    opener = fn;
    if (pending) {
      const { focus } = pending;
      pending = null;
      clearTimer();
      fn(focus);
    }
    return () => {
      if (opener === fn) opener = null;
    };
  }

  /** 소개를 연다 — 등록 전이면 마지막 요청 하나를 잡아 두고 waitMs 뒤에도 등록이 없으면 fallback. */
  function open(focus: GuideFocus | null): void {
    if (opener) {
      opener(focus);
      return;
    }
    pending = { focus };
    clearTimer();
    timer = schedule(() => {
      timer = null;
      const waiting = pending;
      pending = null;
      if (waiting) fallback(waiting.focus);
    }, waitMs);
  }

  return { register, open };
}
