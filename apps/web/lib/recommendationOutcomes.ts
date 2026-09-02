import { apiClient, httpStatus } from '@/lib/api-client';

const QUEUE_KEY = 'nextspot_recommendation_outcome_queue';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type OutcomeStage = 'navigation_started' | 'arrival_confirmed' | 'rated';
export type OutcomeRating = 'up' | 'down';
export type ObservedCongestion = 'quiet' | 'normal' | 'busy';

interface QueuedOutcome {
  recommendationId: string;
  stage: OutcomeStage;
  rating?: OutcomeRating;
  observedCongestion?: ObservedCongestion;
  queuedAt: number;
}

let flushing: Promise<void> | null = null;

function readQueue(): QueuedOutcome[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function writeQueue(items: QueuedOutcome[]): void {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(items)); } catch { /* optional telemetry */ }
}

// 큐에 남겨 둘 최대 기간. 넘으면 버린다 — 몇 주 지난 추천 결과는 학습에도 쓸모가 없고,
// 남겨 두면 되지도 않을 재시도를 앱 실행마다 반복한다.
const MAX_QUEUE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// 다시 보내도 결과가 같은 상태들. 추천 행이 지워졌거나(404), 남의 추천이거나(403),
// 본문이 스키마에 안 맞는(422) 경우가 여기다.
//
// **409 는 일부러 넣지 않는다.** 이 엔드포인트의 409 는 "방문 결과 단계 순서가 올바르지
// 않습니다" 이고(recommendations.py:1361), 그건 우리 큐가 순서를 어겨서 나는 오류다 —
// 버리면 우리가 만든 오류로 멀쩡한 arrival/rated 기록을 지우게 된다. 순서가 바로잡히면
// 다음 시도에 통과하고, 영영 안 될 경우는 아래 MAX_QUEUE_AGE_MS 가 걷어낸다.
const PERMANENT_STATUSES = new Set([400, 403, 404, 410, 422]);

/**
 * 이 실패는 다시 시도해서 될 일인가.
 *
 * 구분이 없으면 영구 실패 하나가 큐 맨 앞에 앉아 **그 뒤 전부를 영영 막는다**. 단계 순서를
 * 지키려고 실패 지점 이후를 통째로 되돌려 넣기 때문이다. 오프라인·5xx·타임아웃처럼 진짜로
 * 다시 될 실패에서만 그 보수적인 동작이 맞다.
 *
 * 상태 코드가 없는 실패(네트워크 단절, abort)는 일시적으로 본다 — 모르면 재시도하는 쪽이
 * 텔레메트리를 잃는 쪽보다 안전하다.
 */
export function isPermanentFailure(err: unknown): boolean {
  const status = httpStatus(err);
  return status !== undefined && PERMANENT_STATUSES.has(status);
}

function operationKey(item: QueuedOutcome): string {
  return `${item.recommendationId}:${item.stage}`;
}

export function queueRecommendationOutcome(
  recommendationId: string | undefined,
  stage: OutcomeStage,
  fields: { rating?: OutcomeRating; observedCongestion?: ObservedCongestion } = {},
): void {
  if (!recommendationId || !UUID_RE.test(recommendationId)) return;
  const next: QueuedOutcome = { recommendationId, stage, ...fields, queuedAt: Date.now() };
  const queue = readQueue();
  const existing = queue.findIndex((item) => operationKey(item) === operationKey(next));
  if (existing >= 0) {
    // 같은 단계를 다시 큐에 넣을 때 queuedAt 을 갱신하면 **순서가 뒤집힌다**. flush 가
    // queuedAt 으로 정렬하므로, 먼저 쌓인 navigation_started 가 나중 시각을 달고 뒤로 밀려
    // arrival_confirmed 가 먼저 나가고 서버가 409(단계 순서 오류)를 준다. 원래 시각을 지킨다.
    queue[existing] = { ...queue[existing], ...next, queuedAt: queue[existing].queuedAt };
  } else {
    queue.push(next);
  }
  writeQueue(queue);
  void flushRecommendationOutcomes();
}

export function flushRecommendationOutcomes(): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    const cutoff = Date.now() - MAX_QUEUE_AGE_MS;
    const queue = readQueue()
      .filter((item) => item.queuedAt >= cutoff)
      .sort((a, b) => a.queuedAt - b.queuedAt);
    const remaining: QueuedOutcome[] = [];
    for (let index = 0; index < queue.length; index++) {
      const item = queue[index];
      try {
        await apiClient.patch(`/api/v1/recommendations/${item.recommendationId}/outcome`, {
          stage: item.stage,
          rating: item.rating,
          observedCongestion: item.observedCongestion,
        });
      } catch (err) {
        if (isPermanentFailure(err)) {
          // 몇 번을 보내도 같은 결과다. 이 항목만 버리고 계속 진행한다 — 여기서 멈추면
          // 큐 전체가 영영 막힌다(단계 순서도 지킬 앞 단계가 이미 없으니 의미가 없다).
          continue;
        }
        // 일시적 실패에서만 순서를 보존한다. 앞 단계 실패 뒤의 arrival/rated를 먼저 보내지 않는다.
        remaining.push(...queue.slice(index));
        break;
      }
    }
    writeQueue(remaining);
  })().finally(() => { flushing = null; });
  return flushing;
}
