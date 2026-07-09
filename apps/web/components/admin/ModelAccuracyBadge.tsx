'use client';

import { useState, useEffect } from 'react';
import { BrainCircuit } from 'lucide-react';
import { apiClient } from '@/lib/api-client';

// 혼잡 예측 모델 정확도 배지 — GET /predict/model-info (무인증 공개 메타).
// 수치는 scripts/train.py --evaluate 의 시간순 홀드아웃 백테스트 결과(model.pkl 내장).
// 평가 프로토콜·한계: docs/MODEL_CARD.md
interface ModelInfo {
  trained: boolean;
  // apiClient 가 snake→camel 변환한 metrics (mae, baselineMae, holdoutN, evaluatedAt ...)
  metrics: {
    mae?: number;
    baselineMae?: number;
    holdoutN?: number;
  } | null;
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

  const mae = info.metrics?.mae;
  if (info.trained && mae != null) {
    const holdout = info.metrics?.holdoutN;
    const baseline = info.metrics?.baselineMae;
    return (
      <span
        title={`시간순 홀드아웃 백테스트 — 평균절대오차(혼잡도 %p)${
          baseline != null ? ` · 기준선(평균예측) ±${(baseline * 100).toFixed(1)}%p` : ''
        } · docs/MODEL_CARD.md`}
        className="flex items-center gap-1.5 px-2.5 py-1 bg-emerald-500/10 border border-emerald-500/25 text-emerald-300 rounded-full text-xs font-bold"
      >
        <BrainCircuit size={14} />
        예측 오차 ±{(mae * 100).toFixed(1)}%p{holdout ? ` · 검증 ${holdout}건` : ''}
      </span>
    );
  }

  return (
    <span
      title={
        info.trained
          ? '모델은 학습됐지만 백테스트 전 — python scripts/train.py --evaluate 로 평가하세요.'
          : '모델 미학습 — 예측은 0.5 폴백. python scripts/train.py 로 학습하세요.'
      }
      className="flex items-center gap-1.5 px-2.5 py-1 bg-hanok-card border border-hanok-line text-hanok-muted rounded-full text-xs font-bold"
    >
      <BrainCircuit size={14} />
      {info.trained ? '예측모델 평가 전' : '예측모델 미학습'}
    </span>
  );
}
