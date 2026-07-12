'use client';

import { useEffect } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

// 라우트 세그먼트 에러 바운더리 — Next.js App Router 규약(파일명 고정, 'use client' 필수).
// 렌더 트리 하위(자식 세그먼트) 에러만 잡는다. 루트 레이아웃 자체가 던지는 에러는 이 파일이
// 아니라 app/global-error.tsx 가 담당한다(App Router 규약).
//
// i18n Provider(lib/i18n/I18nProvider.tsx) 는 useContext 로 값을 읽는데, 그 Provider 트리
// 자체가 무너졌거나 아직 마운트되지 않은 상태에서도 에러 바운더리는 떠야 하므로 t() 를 쓰지
// 않고 한국어 문구 + 영어 한 줄을 하드코딩한다.
//
// 정적 export(output:'export') 호환 — 서버 액션/route handler 없이 클라이언트 전용 로직만 사용.
export default function Error({
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
    <div className="min-h-screen w-full flex flex-col items-center justify-center bg-hanji px-6 text-center font-sans">
      <div className="w-16 h-16 rounded-full bg-gold/15 border border-gold flex items-center justify-center mb-6">
        <AlertTriangle className="w-7 h-7 text-gold-deep" strokeWidth={2} />
      </div>
      <h1 className="text-xl font-bold text-muk mb-2">문제가 발생했어요</h1>
      <p className="text-sm text-muk-soft mb-1">Something went wrong.</p>
      <p className="text-sm text-muk-soft mb-8">잠시 후 다시 시도해 주세요.</p>
      <button
        type="button"
        onClick={() => reset()}
        className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-gold hover:bg-gold-deep text-white font-bold transition-colors"
      >
        <RotateCcw className="w-4 h-4" strokeWidth={2.5} />
        다시 시도
      </button>
    </div>
  );
}
