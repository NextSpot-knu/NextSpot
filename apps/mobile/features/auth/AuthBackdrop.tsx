// 로그인·재설정 화면 바탕 — 노을 그라데이션(+ 로그인만 금빛 광원). 장식 전용, 화면 루트의 절대 배치 첫 자식.
//
// 웹 원본(기준 커밋 0d145a1):
//   apps/web/app/login/page.tsx:191-197 — bg-gradient-to-b from-hanji via-hanji-deep to-sunset-1/20
//     + 광원 absolute top-1/3 left-1/2 −translate-x-1/2 · 280×280 · gold/12 · blur 100(원 위쪽 끝이 33% → 중심 33% + 140, 검토 R1 G1-21)
//   apps/web/app/forgot-password/page.tsx:39 — 같은 그라데이션, 광원 없음.
// 끝색은 토큰 auth-sunset-end(#f6dfcf — color-mix(sunset-1 20%, hanji), tokens.test.ts 가 계산식으로 잠근다).
import { StyleSheet, View } from 'react-native';

import { Glow } from '~/components/ui/Glow';
import { Gradient } from '~/components/ui/Gradient';

export function AuthBackdrop({ glow = false }: { glow?: boolean }) {
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[StyleSheet.absoluteFill, { overflow: 'hidden' }]}
    >
      <Gradient name="auth" style={StyleSheet.absoluteFill} />
      {glow && <Glow color="gold" opacity={0.12} size={280} blur={100} position={{ top: '33.333%', left: '50%' }} centeredX />}
    </View>
  );
}
