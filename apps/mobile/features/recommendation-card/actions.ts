// 카드의 세 행동 — 바로 갈래요(수락) · 킵 · 다시 안볼래요(거절)의 서버·저장 부수효과.
//
// 웹 원본: apps/web/app/main/page.tsx 의 handleAccept · handlePutOff · handleReject · maybeShowLabHint · showProfileToast(기준 커밋 0d145a1).
// 웹은 이 행동들을 /main 이 들고 카드는 콜백만 불렀다. 앱은 홈 화면이 가볍도록 부수효과를 여기 두고, 홈에는 '다음에 보일 곳'만 콜백으로 넘긴다.
// 순수 판정은 actionsCore.ts(node 테스트 — actionsCore.test.ts).
import { toast } from '~/components/ui';
import { apiClient, rejectRecommendation, type TravelContext } from '~/lib/core/apiClient';
import { queueRecommendationOutcome } from '~/lib/core/recommendationOutcomes';
import { saveBookmark } from '~/lib/core/savedFacilities';
import { openDrivingDirections, openWalkingDirections } from '~/lib/platform/links';
import { track } from '~/lib/platform/analytics';
import { isServerRecommendationId } from '@/lib/recommendationIds';

import {
  LAB_HINT_KEY,
  PROFILE_TOAST_KEY,
  TASTE_FEEDBACK_KEY,
  acceptNotices,
  bookmarkFrom,
  greetingKey,
  nextLabHintCount,
  postAcceptWithFallback,
} from './actionsCore';
import { displayWalkMinutes } from './cardTimes';
import { recordActiveTrip } from './tripLoop';
import type { SheetCandidate } from './types';

export type NavigationMode = 'walk' | 'car';
export type TFn = (key: string, vars?: Record<string, string | number>) => string;

// ── 부수효과 ───────────────────────────────────────────────────────────────────

/** 취향 학습이 일어날 수 있는 행동을 했다(마이페이지 레이더 배지가 읽는다 — 웹 lib/tasteBadge.markTasteFeedback). */
export function markTasteFeedback(): void {
  try { globalThis.localStorage?.setItem(TASTE_FEEDBACK_KEY, '1'); } catch { /* 무시 */ }
}

function showProfileToastOnce(t: TFn, onView?: () => void): void {
  try {
    if (globalThis.sessionStorage?.getItem(PROFILE_TOAST_KEY) === '1') return;
    globalThis.sessionStorage?.setItem(PROFILE_TOAST_KEY, '1');
  } catch {
    return;
  }
  toast(t('card.profileToast'), onView ? { action: { label: t('card.profileToastView'), onClick: onView } } : undefined);
}

export interface AcceptOptions {
  mode: NavigationMode;
  travelContext?: TravelContext;
  t: TFn;
  /** '취향 프로필에 반영했어요 · 보기' 의 이동(마이페이지). 없으면 버튼 없이 알린다. */
  onViewProfile?: () => void;
}

/**
 * 바로 갈래요 — 수락 기록(fire-and-forget: 실패해도 길안내는 그대로) · 여정 기록 · navigation_started 결과 보고 · 카카오 길안내.
 * 서버 응답에 쿠폰이 있으면 쿠폰함 알림, 취향이 움직였으면 취향 알림(세션에 한 번).
 */
export function acceptCandidate(c: SheetCandidate, opts: AcceptOptions): void {
  const { t } = opts;
  const f = c.facility;
  const recommendationId = isServerRecommendationId(c.recommendationId) ? c.recommendationId : undefined;
  markTasteFeedback();
  postAcceptWithFallback((body) => apiClient.post('/api/v1/recommendations/accept', body), f.id, recommendationId)
    .then((res) => {
      const n = acceptNotices(res, recommendationId);
      if (n.couponRatePct !== null) toast(t('map.couponIssued', { rate: n.couponRatePct }));
      if (n.profile) showProfileToastOnce(t, opts.onViewProfile);
    })
    .catch(() => { /* 조용히 무시(여정 차단 금지) */ });

  const walk = displayWalkMinutes(c.breakdown?.travelTime);
  try {
    recordActiveTrip(f, {
      recommendationId: c.recommendationId,
      walkMinutes: c.breakdown?.travelTime,
      context: opts.travelContext as unknown as Record<string, unknown> | undefined,
      navigationMode: opts.mode,
    });
    queueRecommendationOutcome(c.recommendationId, 'navigation_started');
    track('navigation_started', { facility_type: f.type, navigation_mode: opts.mode, walk_minutes: walk });
  } catch { /* 저장소 차단 환경 무시 */ }

  toast(t(greetingKey(f.type)));
  const dest = { name: f.name, latitude: f.latitude, longitude: f.longitude };
  if (opts.mode === 'walk') {
    toast(t('trip.selectWalking'));
    void openWalkingDirections(dest);
  } else {
    toast(t('trip.driveBasisHint'));
    void openDrivingDirections(dest);
  }
}

/** 킵 — 북마크(로컬 즉시 + Supabase 영속화)하고 '저장했어요' 알림. */
export function keepCandidate(c: SheetCandidate, t: TFn, busyAt = 0.75): void {
  try {
    void saveBookmark(bookmarkFrom(c, busyAt));
  } catch (e) {
    console.warn('Failed to save bookmark:', e);
  }
  toast(t('map.savedToast'));
}

/** 다시 안볼래요 — 서버 적재는 fire-and-forget(다음 추천은 네트워크와 무관하게 바로), 취향 반영 안내(실험실 힌트)는 처음 몇 번만. */
export function rejectCandidate(
  c: SheetCandidate,
  opts: { t: TFn; hasNext: boolean; onViewLab?: () => void },
): void {
  void rejectRecommendation(c.facility.id).catch(() => { /* 거절 UX 는 저장 실패로 끊지 않는다 */ });
  if (opts.hasNext) toast(opts.t('map.rejectToast'));
  markTasteFeedback();
  let raw: string | null = null;
  let works = true;
  try { raw = globalThis.localStorage?.getItem(LAB_HINT_KEY) ?? null; } catch { works = false; }
  const next = nextLabHintCount(raw, works);
  if (next === null) return;
  try { globalThis.localStorage?.setItem(LAB_HINT_KEY, String(next)); } catch { return; }
  toast.info(
    opts.t('lab.hint'),
    opts.onViewLab ? { action: { label: opts.t('card.profileToastView'), onClick: opts.onViewLab } } : undefined,
  );
}

