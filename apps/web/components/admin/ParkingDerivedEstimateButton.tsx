'use client';

// 주차 실측 기반 시설 혼잡 **추정치** 적재 버튼(관리자 수동).
//
// 왜 미리보기를 먼저 보여주나: 이 버튼은 `congestion_logs` 에 수백 행을 쓴다. 되돌리려면
// SQL 을 직접 쳐야 한다. 그런데 눌러 보기 전에는 몇 건이 들어갈지, 원본이 얼마나 낡았는지
// 알 수 없었다 — 그래서 **적재 전에 preview(쓰기 없음) 로 무엇이 들어갈지 먼저 보이고**,
// 그 화면을 본 뒤에만 적재 버튼이 열린다.
//
// 왜 자동 주기 실행이 아닌가: 10분마다 쌓으면 하루 만에 이 표가 추정치 위주가 되고, 나중에
// 진짜 관측이 들어와도 섞인다. 사람이 필요할 때만 누르는 편이 되돌리기 쉽다.
//
// ⚠️ 이 값은 **추정치**다(`evidence_tier='synthetic'`). 추천 순위와 모델 학습에서는 구조적으로
// 빠지며, 관제 화면에만 쓰인다. 문구에서 그 사실을 지우지 말 것 — 지우는 순간 이 화면이
// 추정을 실측으로 파는 자리가 된다.

import React, { useState } from 'react';
import { Gauge, Loader2, AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { adminApiStatus } from '@/lib/admin-api';
import {
  describeEstimateFailure,
  describeEstimateResult,
  formatSnapshotAge,
  summarizeEstimatePreview,
  type EstimateNotice,
  type EstimateSummary,
} from '@/lib/parkingDerivedEstimate';

const TONE_CLASS: Record<EstimateNotice['tone'], string> = {
  ok: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  warn: 'border-amber-300 bg-amber-50 text-amber-900',
  error: 'border-rose-300 bg-rose-50 text-rose-900',
};

const TONE_ICON: Record<EstimateNotice['tone'], React.ElementType> = {
  ok: CheckCircle2,
  warn: AlertTriangle,
  error: AlertTriangle,
};

/** 서버 실패에서 코드를 뽑는다. FastAPI 는 `detail` 에 코드 문자열을 싣는다. */
function failureCode(err: unknown): string | null {
  const message = (err as Error | undefined)?.message;
  if (!message) return null;
  // adminApi/apiClient 는 detail 을 message 로 올린다. 코드처럼 생긴 것만 코드로 취급한다.
  return /^[a-z][a-z0-9_]*$/.test(message) ? message : null;
}

export function ParkingDerivedEstimateButton({ onRecorded }: { onRecorded?: () => void | Promise<void> }) {
  const [preview, setPreview] = useState<EstimateSummary | null>(null);
  const [busy, setBusy] = useState<'preview' | 'record' | null>(null);
  const [notice, setNotice] = useState<EstimateNotice | null>(null);

  const loadPreview = async () => {
    setBusy('preview');
    setNotice(null);
    try {
      const data: EstimateSummary = await apiClient.get(
        '/api/v1/admin/congestion-estimates/parking-derived/preview',
      );
      setPreview(data);
    } catch (err) {
      setPreview(null);
      setNotice(describeEstimateFailure(failureCode(err), adminApiStatus(err)));
    } finally {
      setBusy(null);
    }
  };

  const record = async () => {
    setBusy('record');
    setNotice(null);
    try {
      const data: EstimateSummary = await apiClient.post(
        '/api/v1/admin/congestion-estimates/parking-derived',
      );
      setNotice(describeEstimateResult(data));
      setPreview(null);
      // 적재했을 때만 부모를 다시 조회한다. already_recorded / no_estimates 는 화면에 바뀔
      // 것이 없는데 재조회하면 "뭔가 일어났다" 는 인상만 준다.
      if ((data.inserted ?? 0) > 0 && onRecorded) await onRecorded();
    } catch (err) {
      setNotice(describeEstimateFailure(failureCode(err), adminApiStatus(err)));
    } finally {
      setBusy(null);
    }
  };

  const stale = preview?.stale === true;
  const age = formatSnapshotAge(preview?.derivedFrom?.ageSeconds);
  const NoticeIcon = notice ? TONE_ICON[notice.tone] : Info;

  return (
    <div className="rounded-2xl border border-hanok-line bg-hanok-panel p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="flex items-center gap-2 text-sm font-bold text-hanok-ink">
            <Gauge size={16} className="text-hanok-muted" aria-hidden />
            주차 실측 기반 혼잡 추정 적재
          </h4>
          {/* 이 문단이 이 컴포넌트의 존재 이유다. 숫자만 두면 추정이 실측으로 읽힌다. */}
          <p className="mt-1 text-xs leading-relaxed text-hanok-muted">
            공영주차 실측(경주 ITS)에서 구역별 수요를 계산해 시설별 <strong>추정치</strong>를 만듭니다.
            현장 관측이 아니며, <strong>추천 순위와 모델 학습에는 쓰이지 않습니다</strong> — 관제 화면 전용입니다.
          </p>
        </div>
        <button
          type="button"
          onClick={loadPreview}
          disabled={busy !== null}
          className="flex shrink-0 items-center gap-2 rounded-lg border border-hanok-line px-4 py-2 text-sm font-semibold text-hanok-ink transition-colors hover:bg-hanok-card disabled:opacity-60"
        >
          {busy === 'preview' ? <Loader2 size={15} className="animate-spin" aria-hidden /> : null}
          {busy === 'preview' ? '계산 중…' : '무엇이 들어갈지 먼저 보기'}
        </button>
      </div>

      {preview && (
        <div className="mt-4 rounded-xl border border-hanok-line bg-hanok-card p-4">
          <ul className="space-y-1 text-xs leading-relaxed text-hanok-ink">
            {summarizeEstimatePreview(preview).map((line) => (
              <li key={line}>· {line}</li>
            ))}
            {age && <li>· 원본 스냅샷: {age}{stale ? ' (오래됨)' : ''}</li>}
          </ul>

          {stale ? (
            // 낡은 스냅샷은 preview 에서는 보여주되(관리자가 확인해야 하는 사실이므로)
            // 적재는 서버가 막는다. 버튼을 열어 두면 눌러도 실패하는 조작을 주는 셈이다.
            <p className="mt-3 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-900">
              원본이 오래돼 적재할 수 없습니다. 수집이 연속으로 실패했다는 뜻이라,
              그 값을 지금 시각으로 기록하지 않습니다.
            </p>
          ) : (
            <button
              type="button"
              onClick={record}
              disabled={busy !== null}
              className="mt-3 flex items-center gap-2 rounded-lg bg-gold px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-gold-deep disabled:opacity-60"
            >
              {busy === 'record' ? <Loader2 size={15} className="animate-spin" aria-hidden /> : null}
              {busy === 'record' ? '적재 중…' : '이 내용으로 적재'}
            </button>
          )}
        </div>
      )}

      {notice && (
        <div role="status" className={`mt-4 flex gap-2 rounded-xl border px-4 py-3 text-xs ${TONE_CLASS[notice.tone]}`}>
          <NoticeIcon size={15} className="mt-0.5 shrink-0" aria-hidden />
          <span className="min-w-0">
            <strong className="font-bold">{notice.title}</strong>
            <span className="mt-0.5 block leading-relaxed">{notice.detail}</span>
          </span>
        </div>
      )}
    </div>
  );
}

export default ParkingDerivedEstimateButton;
