// 거절 실험실의 순수 규칙 — 웹 apps/web/app/mypage/lab/page.tsx · lib/api-client.ts 의 타입·상수(기준 커밋 0d145a1).

/** 거절 이유 코드(백엔드 CHECK 제약과 같은 순서). 'other' 만 메모 입력을 연다. */
export type LabReasonCode =
  | 'too_far'
  | 'too_crowded'
  | 'not_my_taste'
  | 'too_expensive'
  | 'closed'
  | 'already_visited'
  | 'bad_timing'
  | 'inaccurate'
  | 'other';

export const REASON_CODES: readonly LabReasonCode[] = [
  'too_far',
  'too_crowded',
  'not_my_taste',
  'too_expensive',
  'closed',
  'already_visited',
  'bad_timing',
  'inaccurate',
  'other',
];

/** GET /api/v1/lab/pending 항목 — 서버가 실제로 주는 키만. id 가 곧 /lab/{id}/… 의 경로 조각이다. */
export interface LabPendingItem {
  id: string;
  recommendationId: string;
  facilityId: string;
  facilityName: string;
  facilityType: string;
  /** 거절이 기록된 시각(ISO). */
  createdAt: string;
  action?: string;
  reasonStatus?: string;
}

/** reason_note DB CHECK 는 200자 이하 — 입력에서 같은 상한을 건다. */
export const NOTE_MAX = 200;

/** 답한 뒤 문구 키 — 서버가 취향 프로필을 실제로 움직였을 때만 '반영했어요'(P0-5 c). */
export function answeredKey(result: { updatedVector: boolean }): 'lab.answeredTaste' | 'lab.answered' {
  return result.updatedVector ? 'lab.answeredTaste' : 'lab.answered';
}

/** 4로케일 → Intl BCP47 태그. */
export const INTL_LOCALE: Record<string, string> = { ko: 'ko-KR', en: 'en-US', ja: 'ja-JP', zh: 'zh-CN' };

/** 추천 시각 표기. 못 읽으면 빈 문자열. */
export function formatRecommendedAt(iso: string, locale: string): string {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  try {
    return new Date(ms).toLocaleString(INTL_LOCALE[locale] ?? 'ko-KR', {
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

/** 낙관적 제거 — id 하나를 뺀 새 목록. */
export function withoutItem<T extends { id: string }>(items: readonly T[], id: string): T[] {
  return items.filter((item) => item.id !== id);
}
