// 공유 — RN Share 시트, 실패하면 expo-clipboard 로 복사. 흐름은 shareCore.ts(웹 ShareButton 과 같은 3단계).
// iOS 는 url 칸을 따로 받아 미리보기를 만든다. 안드로이드 Share 는 url 칸이 없어(RN 문서) 문구 뒤에 링크를 붙인다.
import { Platform, Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { clipboardText, shareWithFallback, type ShareInput, type ShareOutcome } from './shareCore';

export type { ShareInput, ShareOutcome } from './shareCore';
export { WEB_ORIGIN, courseShareUrl, reshareCourseUrl, recommendShareUrl, type RecommendShareTarget } from './shareUrls';

async function openSheet(input: ShareInput): Promise<'shared' | 'dismissed'> {
  const result = Platform.OS === 'ios'
    ? await Share.share({ url: input.url, message: input.message || undefined, title: input.title })
    : await Share.share({ message: clipboardText(input), title: input.title }, { dialogTitle: input.title });
  return result.action === Share.dismissedAction ? 'dismissed' : 'shared';
}

/** 공유 시트 → 클립보드 → 실패. 결과에 맞는 토스트는 화면이 띄운다('copied' → common.linkCopied, 'failed' → common.shareFailed). */
export function shareLink(input: ShareInput): Promise<ShareOutcome> {
  return shareWithFallback(input, {
    openSheet,
    copy: (text) => Clipboard.setStringAsync(text),
  });
}

/** 링크만 복사 — 공유 시트 없이. */
export async function copyText(text: string): Promise<boolean> {
  try {
    return await Clipboard.setStringAsync(text);
  } catch {
    return false;
  }
}
