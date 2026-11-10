// 홈 알약 토스트의 값(F10) — react-native 를 모른다(테스트: homeToastSpec.test.ts).
// 웹 원본: apps/web/app/main/page.tsx 5150-5156(렌더) · 659-670(showToast) · globals.css animate-toast.
export const HOME_TOAST = {
  /** 화면 아래에서 잰 자리(px) — 탭 화면 안 좌표는 navInsets.fromScreenBottom(…). */
  fromScreenBottom: 350,
  maxWidth: 384,
  /** 바깥 좌우 여백(웹 px-4). */
  sidePadding: 16,
  durationMs: 3000,
  enterMs: 250,
  enterOffset: 20,
  /** 웹 bg-muk/90. */
  background: 'rgba(43, 35, 32, 0.9)',
  /** 웹 shadow-[0_2px_14px_rgba(43,35,32,0.14)]. */
  shadow: '0px 2px 14px rgba(43, 35, 32, 0.14)',
  paddingX: 20,
  paddingY: 12,
  fontSize: 12,
} as const;

/** 한 칸 토스트의 다음 상태 — 새 메시지가 앞 메시지를 덮는다(id 가 바뀌어 타이머가 다시 시작). */
export function nextToast(previous: { id: number } | null, message: string): { id: number; message: string } {
  return { id: (previous?.id ?? 0) + 1, message };
}
