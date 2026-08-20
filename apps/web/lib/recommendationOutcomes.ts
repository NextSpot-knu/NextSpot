import { apiClient } from '@/lib/api-client';

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
  if (existing >= 0) queue[existing] = { ...queue[existing], ...next };
  else queue.push(next);
  writeQueue(queue);
  void flushRecommendationOutcomes();
}

export function flushRecommendationOutcomes(): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    const queue = readQueue().sort((a, b) => a.queuedAt - b.queuedAt);
    const remaining: QueuedOutcome[] = [];
    for (let index = 0; index < queue.length; index++) {
      const item = queue[index];
      try {
        await apiClient.patch(`/api/v1/recommendations/${item.recommendationId}/outcome`, {
          stage: item.stage,
          rating: item.rating,
          observedCongestion: item.observedCongestion,
        });
      } catch {
        // 단계 순서를 보존한다. 앞 단계 실패 뒤의 arrival/rated를 먼저 보내지 않는다.
        remaining.push(...queue.slice(index));
        break;
      }
    }
    writeQueue(remaining);
  })().finally(() => { flushing = null; });
  return flushing;
}
