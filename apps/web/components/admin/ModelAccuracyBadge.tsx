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

  useEffect(() => {
    let active = true;
    apiClient
      .get('/predict/model-info')
      .then(res => {
        if (active) setInfo(res);
      })
      .catch(() => {
        /* 백엔드 미기동 — 배지 비표시 */
      });
    return () => {
      active = false;
    };
  }, []);

  if (!info) return null;

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
      className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-800 border border-slate-700 text-slate-400 rounded-full text-xs font-bold"
    >
      <BrainCircuit size={14} />
      {info.trained ? '예측모델 평가 전' : '예측모델 미학습'}
    </span>
  );
}
