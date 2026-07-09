'use client';

import React, { useState } from 'react';
import { Play } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { getAdminToken } from '@/lib/admin-auth';

// onSimulated: 성공 후 부모 대시보드의 데이터 재조회 콜백(선택). 정적 export 에선 라우터 refresh 가
// 통하지 않아 기존엔 window.location.reload() 로 갱신했는데, 이는 화면 깜빡임·스크롤 소실을 유발했다.
// 콜백이 있으면 리로드 없이 이 함수로 데이터만 다시 불러와 리마운트 없이 히트맵을 갱신한다.
export function SimulatePeakButton({ onSimulated }: { onSimulated?: () => void | Promise<void> }) {
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

      if (onSimulated) {
        // 리로드 없이 재조회 → 히트맵만 갱신되고 스크롤/포커스가 유지된다(깜빡임 없음).
        setMessage('24시간 모의 데이터 생성 완료! 대시보드를 갱신합니다...');
        await onSimulated();
        // 갱신된 히트맵으로 부드럽게 스크롤해 '분산 변화'가 시각적으로 드러나게 한다.
        document
          .getElementById('congestion-heatmap')
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        setMessage('갱신 완료 — 히트맵의 분산 변화를 확인하세요.');
        setTimeout(() => setMessage(null), 4000);
      } else {
        // 콜백 미제공(구 사용처) 폴백: 전체 리로드로 페이지를 리마운트해 실데이터를 재조회한다.
        setMessage('24시간 모의 데이터 생성 완료! 대시보드를 새로고침합니다.');
        setTimeout(() => window.location.reload(), 1200);
      }
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
        className="flex items-center gap-2 px-4 py-2 bg-gold hover:bg-gold-deep disabled:bg-gold text-white font-semibold rounded-lg shadow-sm transition-colors text-sm cursor-pointer"
      >
        <Play size={16} fill="currentColor" />
        {isSimulating ? '모의 데이터 생성 중...' : '24시간 데이터 모의 발생'}
      </button>
    </div>
  );
}
