// 분산 코스 API — 웹 apps/web/app/course/page.tsx 의 fetchCourse 안 호출부(기준 커밋 0d145a1)를 화면에서 떼어 옮겼다.
//
// POST /api/v1/courses/plan(정류지 + 자리별 결과 + planId). 구 API 는 이 경로를 모르므로 404 면 /courses/recommend 로 내려간다 —
// Vercel 과 Render 는 배포 시점이 달라 새 화면이 먼저 뜨는 구간이 실제로 있고, 그때 코스가 통째로 실패하면 장애가 '갈 곳 없음' 으로 보인다.
// 503·429(콜드 스타트)는 2초 뒤 딱 한 번만 다시 보낸다. 유모차 조건을 모르는 옛 API 는 postWithTravelContext 가 빼고 다시 묻고,
// 그때는 같은 판정으로 정류지를 거른다(keepStrollerFriendlyCourse).
import { AuthError, apiClient, httpStatus, postWithTravelContext } from '~/lib/core/apiClient';
import { ensureAnonymousSession } from '~/lib/core/anonymousSession';
import { keepStrollerFriendlyCourse } from '~/lib/core/strollerSupport';

import { normalizePlan } from './model';
import type { CoursePlan, CoursePlanRequest, CourseStop } from './types';

/** 콜드 캐시 첫 코스 생성이 40초 넘게 걸린 실측(웹 2026-09-21) — 기본 10초 대신 60초. */
export const COURSE_TIMEOUT_MS = 60_000;

/** 로그인(익명 포함) 세션의 사용자 id. 없으면 AuthError — 화면이 'needs session' 안내를 그린다. */
export async function currentUserId(): Promise<string> {
  const session = await ensureAnonymousSession();
  const id = session?.user?.id;
  if (!id) throw new AuthError();
  return id;
}

export type CoursePlanBody = Omit<CoursePlanRequest, 'userId'>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function fetchCoursePlan(body: CoursePlanBody): Promise<CoursePlan> {
  const userId = await currentUserId();
  const full: CoursePlanRequest = { userId, ...body };
  let strollerDropped = false;
  const post = async <T>(path: string): Promise<T> => {
    const result = await postWithTravelContext<T>(path, full as unknown as Record<string, unknown> & { context?: unknown }, {
      timeoutMs: COURSE_TIMEOUT_MS,
    });
    strollerDropped = strollerDropped || result.strollerDropped;
    return result.data;
  };

  let plan: CoursePlan;
  try {
    plan = normalizePlan(await post<unknown>('/api/v1/courses/plan'));
  } catch (planErr) {
    const status = httpStatus(planErr);
    if (status === 503 || status === 429) {
      await sleep(2000);
      plan = normalizePlan(await post<unknown>('/api/v1/courses/plan'));
    } else if (status !== 404) {
      throw planErr;
    } else {
      const legacy = await post<CourseStop[]>('/api/v1/courses/recommend');
      // planId 가 빈 문자열이면 '판정할 근거가 없다' — 재계획 토스트를 띄우지 않는다.
      plan = { stops: Array.isArray(legacy) ? legacy : [], slotOutcomes: [], planId: '' };
    }
  }
  if (!strollerDropped) return plan;
  const kept = keepStrollerFriendlyCourse(plan.stops, plan.slotOutcomes);
  return { ...plan, stops: kept.stops, slotOutcomes: kept.outcomes };
}

/** 공유 링크 유입 계측 — fire-and-forget, 실패는 조용히 무시한다. */
export function trackCourseShareVisit(): void {
  Promise.resolve(apiClient.post('/api/v1/events/track', { event: 'course_share_visit', props: { ref: 'share' } })).catch(() => {});
}
