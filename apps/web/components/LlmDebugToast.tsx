'use client';

// LLM 동작 디버그 배지 — 개발 단계 전용 도구. 'AI(Upstage Solar)가 실제로 돌았다 vs 폴백이
// 나왔다'를 화면 좌하단에 잠깐 띄워 기능을 쓸 때마다 즉시 확인할 수 있게 한다.
//
// lib/api-client.ts 가 응답 파싱 직후 중앙에서 발행하는 'nextspot:llm-debug' CustomEvent 를
// 구독한다(voiceTurn/classifyLabReason/getRecommendations·recommendByType). 백엔드가 아직
// llm_status/reason_source 필드를 안 주는 구버전 응답에서는 애초에 이벤트가 발행되지 않으므로
// 이 컴포넌트는 자동으로 조용해진다(무해).
//
// 숨기는 방법(둘 중 하나):
//  1) 코드: 아래 LLM_DEBUG_DEFAULT 를 false 로 바꾼다(심사/고객 공개 시 — HANDOVER 사람 작업 참조).
//  2) 런타임: localStorage 'nextspot_llm_debug' 를 '0'(강제 숨김)으로 설정 — 코드 배포 없이 즉시 끌 때.
//     반대로 '1'이면 LLM_DEBUG_DEFAULT 가 false 여도 강제 표시(로컬 디버깅용 오버라이드).
//
// 표기 문구는 개발자 전용 디버그 도구라 한국어로 하드코딩한다 — 4로케일(ko/en/ja/zh) i18n 대상에서
// 의도적으로 제외한다(lib/i18n/messages/*.json 은 건드리지 않음).

import { useEffect, useState } from 'react';

/** 심사/고객 공개 시 false 로 전환(HANDOVER 사람 작업 참조). */
export const LLM_DEBUG_DEFAULT = true;

const STORAGE_KEY = 'nextspot_llm_debug';
const AUTO_DISMISS_MS = 4000;
const MAX_BADGES = 3;
const EVENT_NAME = 'nextspot:llm-debug';

type LlmDebugDetail =
  | { feature: 'voice' | 'lab' | 'pref' | 'briefing' | 'festival' | 'merchant'; status: string }
  | { feature: 'reason'; llmCount: number; templateCount: number };

interface Badge {
  id: number;
  text: string;
}

let badgeIdSeq = 0;

const FEATURE_LABELS = {
  voice: '음성', lab: '실험실', pref: '선호 분석', briefing: '브리핑',
  festival: '축제 요약', merchant: '사장님 브리핑',
} as const;

// status 공통 문구. feature 는 'llm'/'keyword' 일 때만 구분 표기.
function voiceLabLabel(feature: keyof typeof FEATURE_LABELS, status: string): string {
  const name = FEATURE_LABELS[feature];
  if (status === 'llm') {
    return feature === 'lab' ? '🤖 실험실: Solar 분류' : `🤖 ${name}: Solar 응답`;
  }
  switch (status) {
    case 'keyword':
      return `⚙️ ${name}: 키워드 분류(LLM 불필요)`;
    case 'llm_failed':
      return '🛟 LLM 실패 → 규칙 폴백';
    case 'rejected':
      return '🛟 정직성 게이트 기각 → 폴백';
    case 'gated':
      return '⏳ 조건 미충족/레이트리밋 → 폴백';
    case 'skipped':
      return '⏭️ 데이터 부족 → LLM 미호출';
    case 'pending':
      return `⏳ ${name}: 백그라운드 생성 중`;
    case 'disabled':
      return '⛔ LLM 비활성(키 미설정)';
    default:
      // 백엔드 계약이 아직 유동적일 수 있어(병렬 구현 중) 알 수 없는 status 도 죽지 않고 그대로 보여준다.
      return `${name}: ${status}`;
  }
}

function formatDetail(detail: LlmDebugDetail | undefined): string | null {
  if (!detail) return null;
  if (detail.feature === 'reason') {
    return `🤖 추천 사유: AI ${detail.llmCount} · 템플릿 ${detail.templateCount}`;
  }
  return voiceLabLabel(detail.feature, detail.status);
}

export default function LlmDebugToast() {
  // 마운트 전(서버 렌더 포함)에는 항상 false — localStorage 는 useEffect 안에서만 읽는다(정적 export SSR 안전).
  const [enabled, setEnabled] = useState(false);
  const [badges, setBadges] = useState<Badge[]>([]);

  useEffect(() => {
    try {
      const override = localStorage.getItem(STORAGE_KEY);
      if (override === '0') {
        setEnabled(false);
        return;
      }
      if (override === '1') {
        setEnabled(true);
        return;
      }
    } catch {
      /* localStorage 차단 환경 — 기본값으로 폴백 */
    }
    setEnabled(LLM_DEBUG_DEFAULT);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    // 자동 소멸 타이머는 cleanup 에서 전부 해제 — Fast Refresh/재마운트 시 언마운트된
    // 컴포넌트의 setState 콜백이 남는 것을 방지(Codex P2).
    const timers = new Set<number>();
    const handler = (e: Event) => {
      const text = formatDetail((e as CustomEvent<LlmDebugDetail>).detail);
      if (!text) return;
      const id = badgeIdSeq++;
      setBadges((prev) => [...prev, { id, text }].slice(-MAX_BADGES));
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        setBadges((prev) => prev.filter((b) => b.id !== id));
      }, AUTO_DISMISS_MS);
      timers.add(timer);
    };
    window.addEventListener(EVENT_NAME, handler);
    return () => {
      window.removeEventListener(EVENT_NAME, handler);
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [enabled]);

  if (!enabled || badges.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="fixed z-[80] left-3 bottom-[calc(88px+env(safe-area-inset-bottom))] flex flex-col gap-1.5 pointer-events-none max-w-[85vw]"
    >
      {badges.map((b) => (
        <span
          key={b.id}
          className="inline-flex w-fit items-center gap-1 rounded-full bg-muk/90 px-2.5 py-1 text-[11px] font-medium text-white shadow-lg backdrop-blur-sm whitespace-nowrap"
        >
          {b.text}
        </span>
      ))}
    </div>
  );
}
