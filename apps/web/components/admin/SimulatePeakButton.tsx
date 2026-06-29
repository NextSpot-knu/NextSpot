'use client';

import React, { useState } from 'react';
import { Play } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { getAdminToken } from '@/lib/admin-auth';

export function SimulatePeakButton() {
  const [isSimulating, setIsSimulating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const handleSimulate = async () => {
    setIsSimulating(true);
    setMessage(null);
    try {
      // 관리자 세션 토큰을 X-Admin-Authorization 으로 전달(게이트웨이가 Authorization 을 OIDC 로
      // 덮어쓰므로 별도 헤더). 데모 토큰이며 실제 권한 검증은 백엔드 책임이다.
      const idToken = getAdminToken();
      await apiClient.post(
        '/api/v1/admin/simulate-peak',
        undefined,
        idToken ? { headers: { 'X-Admin-Authorization': `Bearer ${idToken}` } } : undefined
      );
      setMessage('24시간 모의 데이터 생성 완료! 대시보드를 새로고침합니다.');
      // 정적 export(output:'export')에선 router.refresh()가 대시보드의 useEffect([]) loadData 를 재실행하지
      // 않아 화면이 갱신되지 않는다(거짓 성공). 전체 리로드로 페이지를 리마운트해 실데이터를 재조회한다.
      setTimeout(() => window.location.reload(), 1200);
    } catch (err: any) {
      setMessage(`시뮬레이션 실패: ${err?.message || '알 수 없는 오류'}`);
      setTimeout(() => setMessage(null), 5000);
    } finally {
      setIsSimulating(false);
    }
  };

  return (
    <div className="flex items-center gap-4">
      {message && (
        <span className={`text-xs font-bold transition-all ${message.includes('완료') ? 'text-emerald-600 animate-pulse' : 'text-rose-600'}`}>
          {message}
        </span>
      )}
      <button
        onClick={handleSimulate}
        disabled={isSimulating}
        className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-semibold rounded-lg shadow-sm transition-colors text-sm cursor-pointer"
      >
        <Play size={16} fill="currentColor" />
        {isSimulating ? '모의 데이터 생성 중...' : '24시간 데이터 모의 발생'}
      </button>
    </div>
  );
}
