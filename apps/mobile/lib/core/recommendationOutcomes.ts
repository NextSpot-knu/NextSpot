// 추천 결과(길안내 시작·도착 확인·평가) 전송 큐 — 오프라인·일시 실패에도 순서를 지켜 나중에 보낸다.
//
// 웹 원본: apps/web/lib/recommendationOutcomes.ts (기준 커밋 e07ea61)
// 바꾼 것:
//   · 지역 필드·지역 헤더를 뺐다(앱 v1 은 경주만). 웹이 쌓은 큐를 읽을 일은 없지만, region 이 붙은 항목이 있어도 무시하고 보낸다.
//   · window CustomEvent('nextspot:crowd-answer') → appEvents.emit('crowd-answer').
//   · 저장소는 전역 localStorage(expo-sqlite).
//   규칙(같은 단계는 처음 시각 유지 · 영구 실패만 버림 · 일시 실패면 그 뒤를 통째로 보존 · 7일 컷오프 · 되쓰기 전 다시 읽기)은 같다.
import { apiClient, httpStatus } from './apiClient';
import { appEvents } from './events';

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

/** 응답 본문(camelCase)에서 crowdAnswer — registered · guest_shadow · guest_live · not_recorded_*. 없으면 null. */
export function readCrowdAnswer(response: unknown): string | null {
  if (!response || typeof response !== 'object') return null;
  const value = (response as { crowdAnswer?: unknown }).crowdAnswer;
  return typeof value === 'string' ? value : null;
}

/** 서버가 이번 혼잡 답을 저장하지 않았는가(평가는 저장됨). */
export function isUnrecordedCrowdAnswer(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith('not_recorded');
}

function readQueue(): QueuedOutcome[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function writeQueue(items: QueuedOutcome[]): void {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(items)); } catch { /* 선택 텔레메트리 */ }
}

const MAX_QUEUE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// 다시 보내도 같은 결과인 상태. 409 는 서버 RPC 의 단계 순서 거절 — 남겨 두면 큐 맨 앞에서 뒤를 7일 막는다.
const PERMANENT_STATUSES = new Set([400, 403, 404, 409, 410, 422]);

/** 다시 시도해도 될 일인가. 상태 코드가 없는 실패(네트워크·중단)는 일시적으로 본다. */
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
    // 처음 시각을 지킨다 — 갱신하면 정렬이 뒤집혀 서버가 409(단계 순서)를 준다.
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
        const response = await apiClient.patch(`/api/v1/recommendations/${item.recommendationId}/outcome`, {
          stage: item.stage,
          rating: item.rating,
          observedCongestion: item.observedCongestion,
        });
        if (item.stage === 'rated' && item.observedCongestion) {
          appEvents.emit('crowd-answer', {
            recommendationId: item.recommendationId,
            crowdAnswer: readCrowdAnswer(response),
          });
        }
      } catch (err) {
        if (isPermanentFailure(err)) {
          console.warn('recommendation_outcome_dropped', {
            recommendationId: item.recommendationId,
            stage: item.stage,
            status: httpStatus(err),
          });
          continue;
        }
        remaining.push(...queue.slice(index));
        break;
      }
    }

    // 루프 동안 새로 쌓인 항목을 합친다(만료 필터를 다시 걸어서 — 웹 주석 참고).
    const handled = new Set(queue.map(operationKey));
    const arrivedDuringFlush = readQueue().filter(
      (item) => !handled.has(operationKey(item)) && item.queuedAt >= cutoff,
    );
    writeQueue([...remaining, ...arrivedDuringFlush]);
  })().finally(() => { flushing = null; });
  return flushing;
}
