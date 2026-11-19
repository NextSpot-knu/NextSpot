// 운영자 공지 '닫기' 를 기기에 기억한다 — 공지 **문구**로 기억해 새 공지는 다시 보인다.
//
// 웹 원본: apps/web/lib/noticeDismissal.ts (기준 커밋 e07ea61)
// 바꾼 것: `window.localStorage` → 전역 localStorage(expo-sqlite). 웹 모듈은 window. 때문에 check:shared 에 걸린다.
//          저장 키·판정 규칙은 같다. 저장소를 주입할 수 있게 했다(테스트).
const STORAGE_KEY = 'nextspot_notice_dismissed';

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStore(): KeyValueStore | null {
  return (globalThis as { localStorage?: Storage }).localStorage ?? null;
}

export function readDismissedNotice(store: KeyValueStore | null = defaultStore()): string | null {
  try {
    return store?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function writeDismissedNotice(noticeText: string, store: KeyValueStore | null = defaultStore()): void {
  try {
    store?.setItem(STORAGE_KEY, noticeText);
  } catch { /* 기억하지 못할 뿐 — 배너는 정상 동작 */ }
}

/** 빈 공지는 보이지 않는다. 닫은 문구와 정확히 같을 때만 숨긴다. */
export function shouldShowNotice(noticeText: string, dismissed: string | null): boolean {
  if (noticeText === '') return false;
  return dismissed !== noticeText;
}
