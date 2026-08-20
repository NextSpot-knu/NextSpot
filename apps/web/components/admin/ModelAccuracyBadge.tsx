'use client';

import { useState, useEffect } from 'react';
import { BrainCircuit } from 'lucide-react';
import { apiClient } from '@/lib/api-client';

// 혼잡 예측 모델 정확도 배지 — GET /predict/model-info (무인증 공개 메타).
// 비공개 Storage active 모델의 최근 7일 홀드아웃 결과만 표시한다.
interface ModelInfo {
  trained: boolean;
  version: string | null;
  realDataCount: number;
  mae: number | null;
  baselineImprovement: number | null;
  fallbackState: 'degraded_rules' | null;
}

export function ModelAccuracyBadge() {
  const [info, setInfo] = useState<ModelInfo | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    apiClient
      .get('/predict/model-info')
      .then(res => {
        if (active) setInfo(res);
      })
      .catch(() => {
        // 백엔드 미기동/네트워크 실패 — 배지를 지우지 않고 중립 상태로 자리 유지
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);

  // 응답 전(로딩)·실패 시 — null 반환으로 헤더에서 증발하지 않도록 중립 배지로 자리 유지.
  // failed 여부로 '오프라인'과 '상태 확인 중'을 구분(정상 분기는 info 도착 후 아래에서 처리).
  if (!info) {
    return (
      <span
        title={
          failed
            ? '예측모델 상태를 가져오지 못했습니다 — 백엔드(8000) 기동 여부를 확인하세요.'
            : '예측모델 상태 확인 중 — 백엔드 응답 대기'
        }
        className="flex items-center gap-1.5 px-2.5 py-1 bg-hanok-card border border-hanok-line text-hanok-muted rounded-full text-xs font-bold"
      >
        <BrainCircuit size={14} />
        {failed ? '예측모델 오프라인' : '예측모델 상태 확인 중'}
      </span>
    );
  }

  const mae = info.mae;
  if (info.trained && mae != null) {
    return (
      <span
        title={`활성 ${info.version} · 검증 실데이터 ${info.realDataCount}건 · 기준선 대비 ${((info.baselineImprovement ?? 0) * 100).toFixed(1)}% 개선`}
        className="flex items-center gap-1.5 px-2.5 py-1 bg-emerald-500/10 border border-emerald-500/25 text-emerald-300 rounded-full text-xs font-bold"
      >
        <BrainCircuit size={14} />
        예측 오차 ±{(mae * 100).toFixed(1)}%p · 실데이터 {info.realDataCount}건
      </span>
    );
  }

  return (
    <span
      title={
        info.trained
          ? '활성 모델 메타데이터를 확인할 수 없습니다.'
          : '검증된 활성 모델이 없어 취향·실제 이동시간·혜택만으로 추천합니다. 혼잡도와 예상 대기시간은 표시하지 않습니다.'
      }
      className="flex items-center gap-1.5 px-2.5 py-1 bg-hanok-card border border-hanok-line text-hanok-muted rounded-full text-xs font-bold"
    >
      <BrainCircuit size={14} />
      {info.trained ? '예측모델 확인 필요' : '규칙 기반 안전 모드'}
    </span>
  );
}
