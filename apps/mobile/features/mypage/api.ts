// 마이페이지 API 호출 — 웹 apps/web/lib/api-client.ts 의 같은 이름 함수를 앱 apiClient 로 옮겼다(기준 커밋 0d145a1).
// 웹 화면이 직접 `apiClient.get('/api/v1/…')` 하던 곳(쿠폰·임팩트·내 문의·취향 벡터)도 여기 한 곳에 모았다.
// 응답 키는 apiClient 가 camelCase 로 바꿔 준다(웹과 같다).
import { readImpactSummary, type ImpactSummary } from '@/lib/impactSummary';
import { apiClient } from '~/lib/core/apiClient';

import type { Coupon } from './couponCore';
import { readInquiries, type InquiryItem } from './inquiryCore';
import type { LabPendingItem } from './labCore';

export type { Coupon } from './couponCore';
export type { InquiryItem } from './inquiryCore';
export type { LabPendingItem, LabReasonCode } from './labCore';

// ── 쿠폰 ──
/** GET /api/v1/coupons/mine — 내 쿠폰 목록. */
export async function fetchMyCoupons(): Promise<Coupon[]> {
  const data = await apiClient.get('/api/v1/coupons/mine');
  return Array.isArray(data) ? (data as Coupon[]) : [];
}

/** POST /api/v1/coupons/{id}/use — 쿠폰 사용 처리. */
export async function markCouponUsed(couponId: string): Promise<void> {
  await apiClient.post(`/api/v1/coupons/${encodeURIComponent(couponId)}/use`);
}

// ── 임팩트 ──
/** GET /api/v1/impact/summary — 화면이 쓰는 숫자로 읽어 돌려준다(@/lib/impactSummary). */
export async function fetchImpactSummary(): Promise<ImpactSummary> {
  return readImpactSummary(await apiClient.get('/api/v1/impact/summary'));
}

// ── 내 문의 ──
/** GET /api/v1/inquiries/mine — 본인 문의와 관리자 답변. */
export async function fetchMyInquiries(): Promise<InquiryItem[]> {
  return readInquiries(await apiClient.get('/api/v1/inquiries/mine'));
}

// ── 취향 벡터 ──
/** GET /api/v1/users/me/vector — 학습된 8차원 벡터. 길이가 8 이 아니면 null(웹 TasteRadar 와 같은 판정). */
export async function fetchTasteVector(): Promise<number[] | null> {
  const data = await apiClient.get('/api/v1/users/me/vector');
  const vector: unknown = data?.vector;
  if (Array.isArray(vector) && vector.length === 8 && vector.every((v) => typeof v === 'number')) {
    return vector as number[];
  }
  return null;
}

// ── 거절 실험실 ──
/** 본인의 이유 미응답 거절 목록 — 숨김 제외, 30일 이내, 최신순 최대 10건. */
export async function fetchLabPending(): Promise<LabPendingItem[]> {
  const data = await apiClient.get('/api/v1/lab/pending');
  return Array.isArray(data) ? (data as LabPendingItem[]) : [];
}

/** 이유 질문 대기 건수 — 카드 표시용. */
export async function fetchLabPendingCount(): Promise<number> {
  const data: { count?: number } | null = await apiClient.get('/api/v1/lab/pending/count');
  return Math.max(0, Math.round(Number(data?.count) || 0));
}

/** 거절 이유 응답. updatedVector = 서버가 이 답으로 취향 프로필을 실제로 움직였는가(없으면 false). */
export async function answerLabReason(
  feedbackId: string,
  reasonCode: string,
  reasonNote?: string,
): Promise<{ updatedVector: boolean }> {
  const data: { updatedVector?: boolean } | null = await apiClient.post(
    `/api/v1/lab/${encodeURIComponent(feedbackId)}/reason`,
    { reasonCode, reasonNote },
  );
  return { updatedVector: data?.updatedVector === true };
}

/** 자유 텍스트 이유를 서버가 LLM 으로 기존 카테고리에 매핑한다. resolved=false 면 화면이 '골라 주세요' 로 폴백한다. */
export async function classifyLabReason(
  feedbackId: string,
  text: string,
): Promise<{ resolved: boolean; updatedVector: boolean }> {
  const data: { resolved?: boolean; updatedVector?: boolean } | null = await apiClient.post(
    `/api/v1/lab/${encodeURIComponent(feedbackId)}/reason/classify`,
    { text },
  );
  return { resolved: data?.resolved === true, updatedVector: data?.updatedVector === true };
}

/** 이유 응답 건너뛰기. */
export async function skipLabItem(feedbackId: string): Promise<void> {
  await apiClient.post(`/api/v1/lab/${encodeURIComponent(feedbackId)}/skip`);
}

/** 목록에서 숨기기. */
export async function hideLabItem(feedbackId: string): Promise<void> {
  await apiClient.post(`/api/v1/lab/${encodeURIComponent(feedbackId)}/hide`);
}
