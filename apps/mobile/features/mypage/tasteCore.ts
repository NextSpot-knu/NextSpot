// 취향 레이더의 순수 규칙 — 웹 apps/web/components/TasteRadar.tsx(차원·콜드스타트 벡터)와 lib/tasteBadge.ts(배지 판정),
// lib/travelContext.ts 의 loadTravelContext(저장된 카테고리 읽기)를 옮겼다(기준 커밋 0d145a1). 레이더 도형 계산은 앱 전용(react-native-svg).

/** 8차원 선호 벡터의 차원 — apps/api/app/services/spot/preference.py 와 1:1. */
export const DIMENSION_IDS = ['restaurant', 'cafe', 'attraction', 'culture', 'taste', 'mood', 'access', 'quiet'] as const;
export const AXIS_KEYS = DIMENSION_IDS.map((id) => `taste.axis.${id}`);
export const TAG_KEYS = DIMENSION_IDS.map((id) => `taste.tag.${id}`);

/** 표시 전용 폴백 — 백엔드 CATEGORY_VECTORS 를 그대로 재현(점수 산정은 백엔드가 단일 소스). */
const CATEGORY_BASE_VECTORS: Record<string, number[]> = {
  restaurant: [1.0, 0.0, 0.0, 0.0, 0.3, 0.0, 0.0, 0.0],
  cafe: [0.0, 1.0, 0.0, 0.0, 0.1, 0.3, 0.0, 0.0],
  attraction: [0.0, 0.0, 1.0, 0.0, 0.0, 0.1, 0.2, 0.0],
  culture: [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.2, 0.2],
};

/** 선호 미설정 시 균등 벡터(1/√8). */
export const UNIFORM_VECTOR: readonly number[] = new Array(8).fill(1 / Math.sqrt(8));

export type VectorSource = 'learned' | 'onboarding' | 'default';
export type TasteBadge = 'learned' | 'onboarding' | null;

function l2Normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

/** 선택한 카테고리들의 기저 벡터 평균 → L2 정규화. 고른 것이 없으면 null. */
export function onboardingVector(categories: readonly string[]): number[] | null {
  const known = categories.filter((key) => key in CATEGORY_BASE_VECTORS);
  if (known.length === 0) return null;
  const sum = new Array(8).fill(0);
  for (const key of known) CATEGORY_BASE_VECTORS[key].forEach((v, i) => { sum[i] += v; });
  return l2Normalize(sum.map((v) => v / known.length));
}

const LEGACY_CATEGORY: Record<string, string> = { '음식점': 'restaurant', '카페': 'cafe', '관광지': 'attraction', '문화시설': 'culture' };

/** 저장된 첫 설정(nextspot_setup_prefs)에서 카테고리 키만 읽는다. v2 {categories}, v1 {category: 한글} 모두. */
export function categoriesFromStored(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.version === 2) {
      return Array.isArray(value.categories) ? value.categories.filter((c): c is string => typeof c === 'string') : [];
    }
    const legacy = LEGACY_CATEGORY[String(value.category ?? '')];
    return legacy ? [legacy] : [];
  } catch {
    return [];
  }
}

export const TASTE_SAME_EPSILON = 0.02;

function close(a: readonly number[], b: readonly number[] | null | undefined): boolean {
  if (!b || a.length !== b.length) return false;
  return a.every((v, i) => Math.abs(v - b[i]) < TASTE_SAME_EPSILON);
}

/** 출처 배지 — '실시간 학습 반영' 은 정말 움직인 뒤에만. */
export function tasteBadge(
  source: VectorSource,
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

export const TASTE_FEEDBACK_KEY = 'nextspot_taste_feedback_v1';

/** 이 기기에서 취향 학습 행동을 한 적이 있는가. */
export function readTasteFeedback(store: Pick<Storage, 'getItem'> | null = (globalThis as { localStorage?: Storage }).localStorage ?? null): boolean {
  try { return store?.getItem(TASTE_FEEDBACK_KEY) === '1'; } catch { return false; }
}

/** 값이 큰 순으로 상위 n 개 차원 인덱스. */
export function topDimensions(vector: readonly number[], n = 2): number[] {
  return vector
    .map((value, idx) => ({ value, idx }))
    .sort((a, b) => b.value - a.value)
    .slice(0, n)
    .map(({ idx }) => idx);
}

/** 0~1 벡터 → 0~100 정수(레이더 값·읽기 화면용). */
export function radarValues(vector: readonly number[]): number[] {
  return Array.from({ length: 8 }, (_, i) => Math.round(Math.max(0, Math.min(1, vector[i] ?? 0)) * 100));
}

export interface Point { x: number; y: number }

/** n 개 축 중 i 번째의 방향(12시 시작, 시계 방향) 단위 벡터. */
export function axisDirection(i: number, n: number): Point {
  const angle = -Math.PI / 2 + (2 * Math.PI * i) / n;
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

/** 반지름 r(0~1 비율)에서의 점. */
export function radarPoint(i: number, n: number, ratio: number, cx: number, cy: number, radius: number): Point {
  const d = axisDirection(i, n);
  return { x: cx + d.x * radius * ratio, y: cy + d.y * radius * ratio };
}

/** SVG polygon points 문자열. */
export function polygonPoints(points: readonly Point[]): string {
  return points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
}

/** 값(0~100) 배열의 도형 점들. */
export function radarPolygon(values: readonly number[], cx: number, cy: number, radius: number): Point[] {
  return values.map((v, i) => radarPoint(i, values.length, v / 100, cx, cy, radius));
}
