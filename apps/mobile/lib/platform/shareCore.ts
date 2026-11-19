// 공유 흐름 — 웹 apps/web/components/ShareButton.tsx 의 onShare(기준 커밋 e07ea61)를 화면 없이 옮겼다.
// 순수 로직이며 공유 시트·클립보드는 주입한다(share.ts 가 RN Share·expo-clipboard 로 채운다).
//
//   1) 공유 시트. 사용자가 닫은 것(dismissed)은 실패가 아니다 — 조용히 끝낸다.
//   2) 시트가 실패하면 클립보드에 '문구 링크' 를 복사한다 → 'copied'(화면이 common.linkCopied 를 띄운다).
//   3) 둘 다 안 되면 'failed' — 화면이 common.shareFailed 와 링크를 보여 준다(무음 폴백 금지).
// 문구·토스트는 화면이 맡는다(이 모듈은 i18n·토스트를 모른다).

export interface ShareInput {
  title: string;
  message?: string;
  url: string;
}

export type ShareOutcome = 'shared' | 'dismissed' | 'copied' | 'failed';

export interface ShareDeps {
  /** 공유 시트를 띄운다. 사용자가 닫으면 'dismissed', 보냈으면 'shared'. 실패는 throw. */
  openSheet(input: ShareInput): Promise<'shared' | 'dismissed'>;
  /** 클립보드에 쓴다. 실패는 throw 또는 false. */
  copy(text: string): Promise<boolean | void>;
}

export function clipboardText(input: ShareInput): string {
  return `${input.message ?? ''} ${input.url}`.trim();
}

export async function shareWithFallback(input: ShareInput, deps: ShareDeps): Promise<ShareOutcome> {
  try {
    return await deps.openSheet(input);
  } catch {
    /* 시트 실패 — 클립보드로 */
  }
  try {
    const ok = await deps.copy(clipboardText(input));
    if (ok !== false) return 'copied';
  } catch {
    /* 아래로 */
  }
  return 'failed';
}
