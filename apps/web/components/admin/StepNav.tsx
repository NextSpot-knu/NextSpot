'use client';

// 관제 대시보드 단계 바(P9) — '① 실시간 관제 · ② 정책 개입 · ③ 분산 효과' 를 화면 위에 붙여 둔다.
//
// 왜: 기능설명서 ④⑤(KPI → 쿠폰 정책 → 30일 분산 효과)가 한 화면에 다 들어오지 않아, 심사위원은 ②③ 이
// 두세 화면 아래에 있다는 것을 모른 채 첫 화면만 보고 지나갔다(PE09). 단계 이름을 늘 보이게 두고, 누르면
// 그 단계로 옮겨 준다. 실제 대시보드와 데모가 같은 바를 쓴다(두 화면의 순서가 같다).
//
// 각 단계의 시작점은 id 로 찾는다(ADMIN_STEPS[i].id) — 페이지는 그 id 를 단계 배너에 단다.
// 지금 보고 있는 단계는 스크롤 위치로 고른다(바 바로 아래를 지난 마지막 단계, 맨 아래면 마지막 단계).

import { Fragment, useEffect, useState } from 'react';

export interface AdminStep {
  id: string;
  badge: string;
  label: string;
}

export const ADMIN_STEPS: readonly AdminStep[] = [
  { id: 'step-monitor', badge: '①', label: '실시간 관제' },
  { id: 'step-policy', badge: '②', label: '정책 개입' },
  { id: 'step-effect', badge: '③', label: '분산 효과' },
];

/** 단계 시작점이 바 아래 이 거리(px) 안으로 올라오면 그 단계를 '지금' 으로 본다. */
const ACTIVE_OFFSET_PX = 96;

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

export function StepNav({ className = '' }: { className?: string }) {
  const [active, setActive] = useState<string>(ADMIN_STEPS[0].id);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const nav = document.getElementById('admin-step-nav');
      const line = (nav?.getBoundingClientRect().bottom ?? 0) + ACTIVE_OFFSET_PX;
      const first = document.getElementById(ADMIN_STEPS[0].id);
      const scroller = scrollParent(first);
      const atBottom = scroller
        ? scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4
        : window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      let current = ADMIN_STEPS[0].id;
      for (const step of ADMIN_STEPS) {
        const el = document.getElementById(step.id);
        if (el && el.getBoundingClientRect().top <= line) current = step.id;
      }
      if (atBottom) current = ADMIN_STEPS[ADMIN_STEPS.length - 1].id;
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    // 스크롤 이벤트는 거품을 타지 않는다 — 캡처 단계로 받으면 본문 스크롤 컨테이너(관제)와 문서 스크롤(데모 휴대폰)을 함께 듣는다.
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', onScroll);
    onScroll();
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('resize', onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  const go = (id: string) => {
    setActive(id);
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <nav
      id="admin-step-nav"
      aria-label="관제 단계"
      // shrink-0: 가로 스크롤(overflow-x)이 걸린 플렉스 항목은 최소 높이가 0 이 되어 세로 플렉스 본문에서 납작해진다.
      className={`flex flex-shrink-0 items-center gap-1.5 overflow-x-auto no-scrollbar ${className}`}
    >
      {ADMIN_STEPS.map((step, i) => {
        const on = active === step.id;
        return (
          <Fragment key={step.id}>
            {i > 0 && (
              <span aria-hidden="true" className="flex-shrink-0 text-hanok-muted">
                ·
              </span>
            )}
            <button
              type="button"
              onClick={() => go(step.id)}
              aria-current={on ? 'step' : undefined}
              className={`flex-shrink-0 whitespace-nowrap rounded-full border px-3.5 py-1.5 text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 ${
                on
                  ? 'border-hanok-ink bg-hanok-ink text-hanok-card'
                  : 'border-hanok-line bg-hanok-panel text-hanok-ink hover:border-gold/60'
              }`}
            >
              {step.badge} {step.label}
            </button>
          </Fragment>
        );
      })}
    </nav>
  );
}
