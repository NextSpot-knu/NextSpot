'use client';

import { useEffect } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

// 루트 레이아웃(app/layout.tsx) 자체가 렌더 중 에러를 던질 때만 활성화되는 최상위 에러 바운더리.
// Next.js App Router 규약: 이 파일은 루트 레이아웃을 통째로 대체하므로 <html>/<body> 를 직접
// 포함해야 한다(app/error.tsx 와 달리 body 안에만 렌더되는 게 아님).
//
// 루트 레이아웃이 무너진 상황이라 I18nProvider(lib/i18n/I18nProvider.tsx)도 함께 못 붙어있을
// 수 있어 t() 를 쓰지 않고 한국어 문구 + 영어 한 줄을 하드코딩한다. 같은 이유로 layout.tsx 가
// next/font 로 <html> 에 심는 폰트 CSS 변수(--font-noto-sans-kr 등)도 여기서는 없으므로
// globals.css 의 font-sans 유틸(그 변수 체인에 의존)은 쓰지 않고 브라우저 기본 sans-serif 를 쓴다.
// 색 토큰(bg-hanji/text-muk/bg-gold 등)은 :root 에 고정 hex 로 정의돼 있어 정상 동작한다.
//
// 정적 export(output:'export') 호환 — 서버 액션/route handler 없이 클라이언트 전용 로직만 사용.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // 진단용 콘솔 로그. 원격 계측(lib/analytics.ts)은 별도 임무 산출물이며, 계측 호출부 추가는
    // 이번 범위가 아니라 여기서는 붙이지 않는다.
    console.error(error);
  }, [error]);

  return (
    <html lang="ko">
      <body className="min-h-screen w-full flex flex-col items-center justify-center bg-hanji px-6 text-center">
        <div className="w-16 h-16 rounded-full bg-gold/15 border border-gold flex items-center justify-center mb-6">
          <AlertTriangle className="w-7 h-7 text-gold-deep" strokeWidth={2} />
        </div>
        <h1 className="text-xl font-bold text-muk mb-2">문제가 발생했어요</h1>
        <p className="text-sm text-muk-soft mb-1">Something went wrong.</p>
        <p className="text-sm text-muk-soft mb-8">페이지를 새로고침하거나 다시 시도해 주세요.</p>
        <button
          type="button"
          onClick={() => reset()}
          className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-gold hover:bg-gold-deep text-white font-bold transition-colors"
        >
          <RotateCcw className="w-4 h-4" strokeWidth={2.5} />
          다시 시도
        </button>
      </body>
    </html>
  );
}
