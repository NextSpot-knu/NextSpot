// 카드 행동의 순수 판정 — 수락 폴백 · 알림 재료 · 다음 후보 · 북마크 모양 · 실험실 힌트 횟수. React Native 를 import 하지 않아 node 테스트가 돈다.
// 부수효과(전송·저장·알림·길안내)는 actions.ts. 웹 원본: apps/web/app/main/page.tsx 의 handleAccept · handlePutOff · handleReject(기준 커밋 0d145a1).
import { httpStatus } from '~/lib/core/httpCore';
import type { SavedRecord } from '~/lib/core/savedFacilities';

import type { SheetCandidate } from './types';

// ── 순수 ──────────────────────────────────────────────────────────────────────

export interface AcceptResponse {
  couponIssued?: boolean;
  couponRate?: number;
  updatedVector?: boolean;
}

/**
 * 수락 전송 — 추천 id 가 있으면 함께 보내고, 서버가 그 행을 잇지 못하면(없음 404 · 남의 행 403 · 다른 장소 409)
 * 시설 수락으로 한 번만 다시 보낸다. 그 밖의 오류는 그대로 던진다.
 */
export async function postAcceptWithFallback(
  post: (body: { facilityId: string; recommendationId?: string }) => Promise<unknown>,
  facilityId: string,
  recommendationId: string | undefined,
): Promise<AcceptResponse | null> {
  try {
    return (await post(recommendationId ? { facilityId, recommendationId } : { facilityId })) as AcceptResponse | null;
  } catch (err) {
    const status = httpStatus(err);
    if (recommendationId && (status === 404 || status === 403 || status === 409)) {
      return (await post({ facilityId })) as AcceptResponse | null;
    }
    throw err;
  }
}

/** 수락 응답 → 알림 재료. 취향 알림은 서버가 그 추천으로 벡터를 실제로 움직였다고 답했을 때만. */
export function acceptNotices(
  res: AcceptResponse | null | undefined,
  recommendationId: string | undefined,
): { couponRatePct: number | null; profile: boolean } {
  return {
    couponRatePct: res?.couponIssued ? Math.round((res.couponRate ?? 0) * 100) : null,
    profile: !!recommendationId && res?.updatedVector === true,
  };
}

export function greetingKey(type: string | null | undefined): string {
  if (type === 'restaurant') return 'map.greetingRestaurant';
  if (type === 'cafe') return 'map.greetingCafe';
  if (type === 'attraction' || type === 'culture') return 'map.greetingView';
  return 'map.greetingDefault';
}

/** 지금 장소 다음에 보일 후보 — 이미 킵·거절한 곳과 지금 장소는 건너뛴다. 없으면 null(빈 상태). */
export function nextCandidateAfter(
  candidates: readonly SheetCandidate[],
  currentId: string,
  excluded: ReadonlySet<string>,
): SheetCandidate | null {
  for (const c of candidates) {
    const id = String(c.facility.id);
    if (id === String(currentId) || excluded.has(id)) continue;
    return c;
  }
  return null;
}

const CATEGORY_LABEL: Record<string, string> = {
  restaurant: '음식점', cafe: '카페', attraction: '관광지', culture: '문화시설',
};

/** 킵(북마크)으로 저장하는 값 — 웹 handlePutOff 의 모양. 저장 화면이 읽는 필드를 그대로 둔다. */
export function bookmarkFrom(c: SheetCandidate, busyAt = 0.75): SavedRecord {
  const f = c.facility;
  const level = typeof c.congestionLevel === 'number' ? c.congestionLevel : typeof f.congestionLevel === 'number' ? f.congestionLevel : null;
  const grade = level === null ? 'unknown'
    : level >= busyAt ? 'orange' : level >= 0.5 ? 'yellow' : level >= 0.25 ? 'green' : 'blue';
  const modelWait = c.scoringMode === 'model' && c.congestionSource !== 'none' && typeof c.breakdown?.waitTime === 'number'
    ? Math.ceil(c.breakdown.waitTime) : null;
  return {
    id: f.id,
    recommendationId: c.recommendationId,
    name: f.name,
    category: CATEGORY_LABEL[f.type] ?? '문화시설',
    latitude: f.latitude,
    longitude: f.longitude,
    address: f.address ?? null,
    phone: f.phone ?? null,
    features: f.features ?? null,
    trafficStatus: grade,
    congestionLevel: level,
    waitTime: modelWait !== null ? `${modelWait}분` : null,
    waitEvidence: modelWait !== null ? 'verified_model' : undefined,
    spot: {
      score: c.spotScore ?? 0,
      expectedTravel: c.breakdown?.travelTime ?? 0,
      expectedWait: modelWait ?? 0,
      preferencePercent: Math.round((c.breakdown?.preference ?? 0) * 100),
      scoringMode: c.scoringMode,
    },
    reason: c.reason ?? '',
  };
}

export const LAB_HINT_KEY = 'nextspot_lab_hint_shown';
export const LAB_HINT_MAX_SHOWS = 2;

/** 거절 안내(lab.hint)를 처음 몇 번만 — 저장소를 못 읽으면 아예 띄우지 않는다(무한 반복 방지). 다음 횟수를 돌려주고 null 이면 띄우지 않는다. */
export function nextLabHintCount(raw: string | null | undefined, storageWorks: boolean): number | null {
  if (!storageWorks) return null;
  const shown = Number(raw) || 0;
  return shown >= LAB_HINT_MAX_SHOWS ? null : shown + 1;
}

export const PROFILE_TOAST_KEY = 'nextspot_profile_toast_shown';
export const TASTE_FEEDBACK_KEY = 'nextspot_taste_feedback_v1';
