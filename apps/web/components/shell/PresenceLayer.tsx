'use client';

import { motion, useIsPresent, type HTMLMotionProps } from 'framer-motion';

// AnimatePresence 바로 아래에 두는 겹(시트 바탕 등). 닫히는 동안(exit 애니메이션) 화면에 남는 겹은 닫히기 직전 상태 그대로
// 굳은 사본이라 — 예: 히트맵을 켜면서 닫힌 시트의 히트맵 버튼은 여전히 '꺼짐' — 눌리거나 화면 읽기 프로그램에 읽히면 안 된다.
// 사라지는 동안은 누름을 아래로 통과시키고 접근성 트리에서 뺀다(useIsPresent 는 exit 이 시작되면 false).
export function PresenceLayer({ style, ...props }: HTMLMotionProps<'div'>) {
  const present = useIsPresent();
  return (
    <motion.div
      {...props}
      aria-hidden={present ? props['aria-hidden'] : true}
      style={present ? style : { ...style, pointerEvents: 'none' }}
    />
  );
}
