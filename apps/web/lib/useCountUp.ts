// 숫자 카운트업 훅 — 화면의 큰 수치가 0(첫 등장) 또는 직전 표시값(값 갱신)에서 실제 값으로
// 짧게 굴러 올라가, "지금 막 계산된 살아 있는 값"이라는 감각을 준다.
//
// 정직성 규칙(절대): target 은 반드시 상태에 이미 존재하는 **실제 값**이어야 하고, 이 훅은
// 그 값을 향해 보간만 한다 — 값을 만들거나, 부풀리거나, 실제 값 너머로 튀기지 않는다.
// 재애니메이션도 실제 값이 바뀌었을 때만 일어난다(같은 값 재렌더에는 아무 일도 없다).
//
// 정적 export(SSR) 안전: window/matchMedia/requestAnimationFrame 접근은 전부 이펙트 안 +
// typeof 가드. 소비자는 'use client' 컴포넌트다(이 저장소 lib 훅 관례 — useVoiceAssistant 참조).
//
// prefers-reduced-motion: OS가 '동작 줄이기'를 켰으면 굴리지 않고 즉시 최종값으로 점프한다
// (globals.css 의 전역 CSS 규칙과 같은 존중을 JS 애니메이션에도 적용).
import { useEffect, useRef, useState } from 'react';

/** ease-out-cubic — 초반 빠르고 끝에서 감속. 입력은 0..1 로 클램프한다(RAF 마지막 프레임이
 *  duration 을 살짝 넘겨 들어와도 1을 초과한 값이 최종값 너머로 오버슈트하지 않게). */
export function easeOutCubic(t: number): number {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return 1 - Math.pow(1 - clamped, 3);
}

/** 한 프레임의 표시값 — from→to 를 easeOutCubic 진행률로 보간하고 decimals 자리로 반올림.
 *  순수 함수로 분리한 이유: RAF 없이 이 수학만 단위 테스트하기 위해(useCountUp.test.ts). */
export function countUpFrame(from: number, to: number, progress: number, decimals = 0): number {
  const value = from + (to - from) * easeOutCubic(progress);
  const factor = 10 ** Math.max(0, Math.trunc(decimals));
  return Math.round(value * factor) / factor;
}

/**
 * target 을 향해 굴러가는 표시값을 돌려준다.
 * - target 이 처음 유한한 수가 되는 순간 0→target 으로 1회 굴린다.
 * - target 이 실제로 바뀌면 **직전 표시값**에서 새 값으로 다시 굴린다(중간에 바뀌어도 이어짐).
 * - target 이 유한하지 않으면(NaN 등) 아무것도 하지 않는다 — 직전 표시값 유지.
 */
export function useCountUp(
  target: number,
  opts?: { durationMs?: number; decimals?: number },
): number {
  const durationMs = opts?.durationMs ?? 900;
  const decimals = opts?.decimals ?? 0;
  const [display, setDisplay] = useState(0);
  // setState 비동기 반영과 무관하게 "지금 화면에 있는 값"을 즉시 읽기 위한 ref —
  // target 이 애니메이션 도중 바뀌면 여기서부터 이어 굴린다.
  const displayRef = useRef(0);

  useEffect(() => {
    // 유한한 실제 값이 오기 전에는 시작하지 않는다(로딩 중 undefined→NaN 전달 관례).
    if (!Number.isFinite(target)) return;

    // '동작 줄이기' 또는 RAF 미지원 환경 — 즉시 최종값(굴림 없음).
    const reduce =
      typeof window === 'undefined' ||
      typeof window.requestAnimationFrame !== 'function' ||
      (typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (reduce) {
      displayRef.current = target;
      setDisplay(target);
      return;
    }

    const from = displayRef.current;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const progress = durationMs <= 0 ? 1 : (now - start) / durationMs;
      const value = countUpFrame(from, target, progress, decimals);
      displayRef.current = value;
      setDisplay(value);
      if (progress < 1) raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [target, durationMs, decimals]);

  return display;
}
