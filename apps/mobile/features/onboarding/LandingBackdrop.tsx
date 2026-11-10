// 첫 화면(랜딩) 바탕 — 노을 그라데이션 · 금빛 광원 · 아래 노을 광원 · 대릉원 능선 · 반딧불이. 장식 전용(누름·읽기 없음).
//
// 웹 원본: apps/web/app/page.tsx:153-237 (기준 커밋 0d145a1)
//   바탕 bg-gradient-to-b from-hanji via-hanji-deep to-sunset-1/25 → 토큰 gradients.landing(끝색 landing-sunset-end)
//   광원 가운데 300×300 gold/15 blur 100 · 아래 가운데 420×280 sunset-1/20 blur 120(타원 — 원 광원을 세로로 2/3 눌러 근사)
//   능선 viewBox 0 0 1440 240 · xMidYMax slice · 높이 max(26vh, 140) · jade 0.08/0.08/0.13/0.13
//   반딧불이 10개(위치·주기 고정 배열) — '동작 줄이기'면, 그리고 화면이 가려져 있으면 그리지 않는다.
// 화면 루트(Screen 바깥)의 절대 배치 첫 자식으로 둔다 — Screen 은 bg-transparent(검토 R1 G1-02).
import { useIsFocused } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';

import { Glow } from '~/components/ui/Glow';
import { Gradient } from '~/components/ui/Gradient';
import { useReduceMotion } from '~/components/ui/useReduceMotion';
import { colors } from '~/lib/theme/tokens';

const RIDGES = [
  { d: 'M-80 240 Q 260 40 620 240 Z', opacity: 0.08 },
  { d: 'M520 240 Q 900 10 1300 240 Z', opacity: 0.08 },
  { d: 'M-200 240 Q 120 90 460 240 Z', opacity: 0.13 },
  { d: 'M880 240 Q 1240 70 1620 240 Z', opacity: 0.13 },
] as const;

// 웹 :194-205 그대로(초 단위).
const FIREFLIES = [
  { left: 0.12, top: 0.3, size: 5, drift: 11, glow: 5.2, delay: 0 },
  { left: 0.22, top: 0.62, size: 4, drift: 13, glow: 6.1, delay: 1.4 },
  { left: 0.31, top: 0.18, size: 3, drift: 10, glow: 4.6, delay: 2.8 },
  { left: 0.44, top: 0.74, size: 5, drift: 14, glow: 5.8, delay: 0.9 },
  { left: 0.58, top: 0.24, size: 4, drift: 12, glow: 5.0, delay: 2.1 },
  { left: 0.67, top: 0.58, size: 3, drift: 15, glow: 6.6, delay: 3.6 },
  { left: 0.76, top: 0.36, size: 5, drift: 11.5, glow: 4.9, delay: 1.8 },
  { left: 0.85, top: 0.68, size: 4, drift: 13.5, glow: 5.5, delay: 0.4 },
  { left: 0.52, top: 0.44, size: 3, drift: 12.5, glow: 6.3, delay: 4.2 },
  { left: 0.08, top: 0.8, size: 4, drift: 14.5, glow: 5.7, delay: 3.1 },
] as const;

// ns-firefly-drift: 0 → (14,−22) → (−10,−38) → (−20,−14) → 0, ns-firefly-glow: 0 → .9(35%) → .45(55%) → .85(70%) → 0.
const DRIFT_X = [0, 14, -10, -20, 0];
const DRIFT_Y = [0, -22, -38, -14, 0];
const GLOW_AT = [0, 0.35, 0.55, 0.7, 1];
const GLOW_V = [0, 0.9, 0.45, 0.85, 0];

function lerpKeyframes(t: number, at: readonly number[], v: readonly number[]): number {
  'worklet';
  for (let i = 1; i < at.length; i++) {
    if (t <= at[i]) {
      const span = at[i] - at[i - 1];
      const k = span > 0 ? (t - at[i - 1]) / span : 0;
      // ease-in-out 근사(웹 ease-in-out 키프레임 사이)
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      return v[i - 1] + (v[i] - v[i - 1]) * e;
    }
  }
  return v[v.length - 1];
}

function Firefly({ fly, width, height }: { fly: (typeof FIREFLIES)[number]; width: number; height: number }) {
  const drift = useSharedValue(0);
  const glow = useSharedValue(0);
  useEffect(() => {
    const ms = (s: number) => s * 1000;
    drift.value = withDelay(ms(fly.delay), withRepeat(withTiming(1, { duration: ms(fly.drift), easing: Easing.linear }), -1, false));
    glow.value = withDelay(ms(fly.delay), withRepeat(withTiming(1, { duration: ms(fly.glow), easing: Easing.linear }), -1, false));
    return () => {
      cancelAnimation(drift);
      cancelAnimation(glow);
    };
  }, [drift, glow, fly]);
  const style = useAnimatedStyle(() => ({
    opacity: lerpKeyframes(glow.value, GLOW_AT, GLOW_V),
    transform: [
      { translateX: lerpKeyframes(drift.value, [0, 0.25, 0.5, 0.75, 1], DRIFT_X) },
      { translateY: lerpKeyframes(drift.value, [0, 0.25, 0.5, 0.75, 1], DRIFT_Y) },
    ],
  }));
  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          left: fly.left * width,
          top: fly.top * height,
          width: fly.size,
          height: fly.size,
          borderRadius: fly.size / 2,
          backgroundColor: 'rgba(255, 236, 180, 0.95)',
          boxShadow: '0px 0px 10px 3px rgba(193, 154, 62, 0.35)',
        },
        style,
      ]}
    />
  );
}

export function LandingBackdrop() {
  const { width, height } = useWindowDimensions();
  const reduce = useReduceMotion();
  // 랜딩이 가려져 있으면(로그인·설정을 위에 얹음) 반딧불이를 내린다 — 보이지 않는 반복 애니메이션을 돌리지 않는다(검토 L8).
  const focused = useIsFocused();
  const ridgeHeight = Math.max(0.26 * height, 140);
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[StyleSheet.absoluteFill, { overflow: 'hidden' }]}
    >
      <Gradient name="landing" style={StyleSheet.absoluteFill} />
      {/* 가운데 금빛 광원 — 원 상자 가운데가 화면 가운데(top-1/2 left-1/2 −translate). */}
      <View style={{ position: 'absolute', top: '50%', left: '50%', width: 300, height: 300, marginTop: -150, marginLeft: -150 }}>
        <Glow color="gold" opacity={0.15} size={300} blur={100} position={{ top: 0, left: 0 }} />
      </View>
      {/* 반딧불이 */}
      {!reduce && focused && FIREFLIES.map((fly, i) => <Firefly key={i} fly={fly} width={width} height={height} />)}
      {/* 아래 노을 광원 — 420×280 상자, 아래 가운데. 원(420) 광원을 세로 280/420 로 눌러 타원으로. */}
      <View style={{ position: 'absolute', bottom: 0, left: '50%', width: 420, height: 280, marginLeft: -210 }}>
        <View style={{ position: 'absolute', top: -70, left: 0, width: 420, height: 420, transform: [{ scaleY: 280 / 420 }] }}>
          <Glow color="sunset-1" opacity={0.2} size={420} blur={120} position={{ top: 0, left: 0 }} />
        </View>
      </View>
      {/* 대릉원 능선 */}
      <Svg
        width={width}
        height={ridgeHeight}
        viewBox="0 0 1440 240"
        preserveAspectRatio="xMidYMax slice"
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}
      >
        {RIDGES.map((r) => (
          <Path key={r.d} d={r.d} fill={colors.jade} fillOpacity={r.opacity} />
        ))}
      </Svg>
    </View>
  );
}
