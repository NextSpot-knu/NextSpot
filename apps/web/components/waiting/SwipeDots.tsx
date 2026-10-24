'use client';

import { useEffect, useRef, useState } from 'react';

// '지금 출발하면?' 대표 카드를 폰에서 가로로 넘길 때, 지금 몇 번째 카드인지 보여 주는 점.
// 넘기는 줄은 이 점 줄의 바로 앞 형제다(그 줄의 스크롤을 듣는다 — ref 를 섹터마다 넘기지 않아도 된다).
// 넓은 화면(sm 이상)은 카드가 한 줄 격자라 점을 그리지 않는다.
export function SwipeDots({ count }: { count: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const scroller = ref.current?.previousElementSibling as HTMLElement | null;
    if (!scroller) return;
    const onScroll = () => {
      const first = scroller.firstElementChild as HTMLElement | null;
      if (!first) return;
      const step = first.getBoundingClientRect().width + (parseFloat(getComputedStyle(scroller).columnGap) || 0);
      if (step <= 0) return;
      setActive(Math.min(count - 1, Math.max(0, Math.round(scroller.scrollLeft / step))));
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [count]);

  return (
    <div ref={ref} className="mt-2 flex justify-center gap-1.5 sm:hidden" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          className={`h-1.5 rounded-full transition-all duration-200 ${i === active ? 'w-4 bg-gold' : 'w-1.5 bg-line'}`}
        />
      ))}
    </div>
  );
}
