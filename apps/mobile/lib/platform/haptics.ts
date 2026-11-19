// 촉각 피드백 — 웹 apps/web/lib/motion.ts 의 haptic(kind)(기준 커밋 e07ea61)과 같은 세 가지 뜻.
// 웹은 navigator.vibrate 길이로 구분했다(selection 7ms · confirm 12ms · success [10,35,16]). 앱은 OS 표준 피드백으로 옮긴다:
//   selection → selectionAsync()                      고르기(칩·탭 바꾸기)
//   confirm   → impactAsync(Light)                    누름 확정(짧은 한 번)
//   success   → notificationAsync(Success)            끝남(두 번 두드림 — 웹 패턴과 같은 느낌)
// 지원하지 않는 기기·설정(진동 끔, 저전력)은 조용히 통과한다 — 기다리지 않는다.
import * as Haptics from 'expo-haptics';

export type HapticKind = 'selection' | 'confirm' | 'success';

export function haptic(kind: HapticKind = 'selection'): void {
  let pending: Promise<void>;
  try {
    pending = kind === 'success'
      ? Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      : kind === 'confirm'
        ? Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
        : Haptics.selectionAsync();
  } catch {
    return;
  }
  pending.catch(() => {
    /* 미지원 — 무시 */
  });
}
