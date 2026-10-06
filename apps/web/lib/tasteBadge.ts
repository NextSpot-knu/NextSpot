// 마이페이지 AI 취향 프로필(레이더) 머리의 출처 배지 — '실시간 학습 반영' 은 정말 배운 뒤에만(리뷰 10-07).
//
// 왜: 저장도 방문도 0인 새 게스트에게도 '실시간 학습 반영' 이 붙었다. 서버는 벡터가 없으면 균등 벡터를 돌려주고, 화면은
// 서버에서 받았다는 것만으로 '학습' 이라 불렀다 — 아직 일어나지 않은 학습을 말하는 셈(스스로를 치켜세우는 말에 가깝다).
// 이제 이 브라우저에서 수락·거절·좋아요/별로예요를 한 번이라도 했고(markTasteFeedback) 서버 벡터가 균등 벡터나 처음 고른
// 취향(온보딩) 벡터와 다를 때만 '실시간 학습 반영'. 아니면 '처음 고른 취향 반영'(온보딩이 있을 때) 또는 배지 없음.
// (서버는 /setup 에서 고른 취향으로 첫 벡터를 따로 만든다 — 화면의 온보딩 벡터와 값이 달라 벡터만으로는 가를 수 없었다.)

export type TasteBadge = 'learned' | 'onboarding' | null;

const FEEDBACK_KEY = 'nextspot_taste_feedback_v1';

/** 취향 학습이 일어나는 행동(도보 길안내 · 관심 없어요 · 좋아요/별로예요)을 했다고 이 브라우저에 남긴다. */
export function markTasteFeedback(): void {
  try { window.localStorage.setItem(FEEDBACK_KEY, '1'); } catch { /* 저장소 차단 — 배지가 '처음 고른 취향' 에 머문다 */ }
}

/** 이 브라우저에서 취향 학습 행동을 한 적이 있는가. */
export function hasTasteFeedback(): boolean {
  try { return window.localStorage.getItem(FEEDBACK_KEY) === '1'; } catch { return false; }
}

/** 이보다 덜 움직였으면 같은 벡터로 본다(성분별 최대 차이). 수락 한 번(+10%)은 이보다 훨씬 크게 움직인다. */
export const TASTE_SAME_EPSILON = 0.02;

function close(a: readonly number[], b: readonly number[] | null | undefined): boolean {
  if (!b || a.length !== b.length) return false;
  return a.every((v, i) => Math.abs(v - b[i]) < TASTE_SAME_EPSILON);
}

/**
 * source: 벡터를 어디서 얻었나(서버 'learned' · 온보딩 'onboarding' · 균등 'default').
 * baselines: 균등 벡터와(있으면) 온보딩 벡터 — 서버 벡터가 이 중 하나와 같으면 아직 배우지 않았다.
 * hasFeedback: 이 브라우저에서 학습 행동을 했는가(hasTasteFeedback) — 하지 않았으면 학습을 말하지 않는다.
 */
export function tasteBadge(
  source: 'learned' | 'onboarding' | 'default',
  vector: readonly number[],
  baselines: { uniform: readonly number[]; onboarding: readonly number[] | null },
  hasFeedback: boolean,
): TasteBadge {
  if (source === 'default') return null;
  if (source === 'onboarding') return 'onboarding';
  if (!hasFeedback || close(vector, baselines.uniform) || close(vector, baselines.onboarding)) {
    return baselines.onboarding ? 'onboarding' : null;
  }
  return 'learned';
}
