// 혼잡·영업 제보의 순수 판정 — 오류 → 문구 키, 보상 배지, 서버가 받지 않은 영업 답.
// 웹 원본: apps/web/components/CongestionReportButton.tsx · RecommendationCard.tsx 의 submitHoursStatus(기준 커밋 0d145a1).
import { httpStatus, isAuthError } from '~/lib/core/httpCore';

export type ReportLevel = '한산' | '보통' | '혼잡';

/**
 * 혼잡 제보 실패 → 문구 키. 403 은 게스트(익명 세션) — 제보는 계정 로그인부터 받는다. 서버 detail 은 한국어뿐이라 그대로 쓰지 않는다.
 */
export function congestionReportErrorKey(err: unknown): 'report.authError' | 'report.cooldownError' | 'report.failError' {
  if (isAuthError(err) || httpStatus(err) === 403) return 'report.authError';
  if (httpStatus(err) === 429) return 'report.cooldownError';
  return 'report.failError';
}

/** 성공 토스트 뒤에 붙는 진행 배지 — 3회째에는 쿠폰 +1. */
export function rewardBadge(reward: { couponIssued?: boolean; nextRewardIn?: number } | null | undefined): string | null {
  if (!reward) return null;
  if (reward.couponIssued) return '🎟️ +1';
  if (reward.nextRewardIn) return `🎯 ${3 - reward.nextRewardIn}/3`;
  return null;
}

/**
 * 영업 확인 답을 서버가 받지 않았는가 — 게스트(403), 같은 네트워크의 다른 계정이 이미 알린 곳(429). 그래도 사람의 판단은
 * 수락·거절에 쓰되 '확인' 칩은 만들지 않는다(기록된 근거가 아니다).
 */
export function hoursAnswerNotRecorded(err: unknown): boolean {
  const s = httpStatus(err);
  return s === 403 || s === 429;
}
