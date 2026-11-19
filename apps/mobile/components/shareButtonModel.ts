// 공유 버튼의 결과 → 화면 반응(웹 components/ShareButton.tsx) — 순수 로직.
import type { ShareOutcome } from '~/lib/platform/shareCore';

/** 복사되면 체크가 이만큼 남는다(웹 setTimeout 2000). */
export const COPIED_CHECK_MS = 2000;
/** 실패 토스트가 이만큼 남는다(웹 duration 10000) — 사용자가 주소를 직접 복사할 시간. */
export const SHARE_FAILED_TOAST_MS = 10_000;

export type ShareReaction = { copied: boolean; toast: 'copied' | 'failed' | null };

/** 'shared'·'dismissed' 는 조용히 — 닫은 것은 실패가 아니다. 'copied' 는 ✓ + 토스트, 'failed' 는 말한다(무음 폴백 금지). */
export function reactionFor(outcome: ShareOutcome): ShareReaction {
  if (outcome === 'copied') return { copied: true, toast: 'copied' };
  if (outcome === 'failed') return { copied: false, toast: 'failed' };
  return { copied: false, toast: null };
}
