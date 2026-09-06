'use client';

import { MotionConfig } from 'framer-motion';

/** 모든 Framer Motion 전환이 OS의 '동작 줄이기' 설정을 일관되게 따르게 한다. */
export default function MotionProvider({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
