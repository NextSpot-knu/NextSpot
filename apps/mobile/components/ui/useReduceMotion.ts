import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

/**
 * 기기의 '동작 줄이기' — 켜고 끄면 바로 따라간다. Reanimated 의 useReducedMotion 은 앱 시작 때 한 번 읽은 값이라
 * 첫 값으로만 쓰고, 이후 바뀜은 AccessibilityInfo 의 reduceMotionChanged 로 받는다.
 */
export function useReduceMotion(): boolean {
  const initial = useReducedMotion();
  const [reduce, setReduce] = useState(initial);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => alive && setReduce(v))
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return reduce;
}
