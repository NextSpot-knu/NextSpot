// 관리자 화면 지표의 '상태' 판정 — 순수 함수 모음(렌더 없음).
//
// 왜 별도 모듈인가: 관리자 화면은 자동 테스트가 얇은데, 여기 판정이 한 칸만 틀려도
// '조회 실패' 가 화면에 0 으로 그려진다. 관리자는 0 을 '문제 없음' 으로 읽는다.
// 판정을 렌더에서 떼어내 lib/*.test.ts(node:assert) 로 직접 고정한다.
//
// 이 저장소의 원칙: 실패와 '해당 없음' 과 '실측 0' 은 서로 다른 사실이므로 절대
// 같은 값(특히 0)으로 뭉개지 않는다.

/** 지표 하나의 표시 상태. 네 상태는 화면에서 서로 다른 모양이어야 한다. */
export type AdminMetric<T> =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'empty' }
  | { status: 'ok'; value: T };

// ── 대시보드: 혼잡 집계 슬라이스(GET /api/v1/admin/dashboard/today) ────────────
// 서버는 오늘 로그가 5건 미만이면 hasLogs=false + 나머지 전부 null 을 돌려준다(표본 부족).
// 조회 자체가 실패한 경우는 페이지가 { failed: true } 로 표시해 넘긴다.
export interface CongestionSlice {
  /** 조회 실패(네트워크/500/권한). 표본 부족(hasLogs=false)과 다른 사실이다. */
  failed?: boolean;
  hasLogs?: boolean;
  avgCongestion?: { value: number; changePercent: number } | null;
  anomalyCount?: number | null;
  heatmap?: unknown[] | null;
  anomalies?: unknown[] | null;
}

/**
 * 혼잡 집계 슬라이스에서 지표 하나를 뽑아 상태를 판정한다.
 * slice === null 은 '아직 로딩 중'(요청이 끝나지 않음)을 뜻한다.
 */
export function congestionMetric<T>(
  slice: CongestionSlice | null,
  pick: (s: CongestionSlice) => T | null | undefined,
): AdminMetric<T> {
  if (slice === null) return { status: 'loading' };
  if (slice.failed) return { status: 'failed' };
  if (!slice.hasLogs) return { status: 'empty' };
  const value = pick(slice);
  // 0 은 정상값이므로 falsy 가 아니라 null/undefined 만 '표본 없음' 으로 본다.
  if (value === null || value === undefined) return { status: 'empty' };
  return { status: 'ok', value };
}

// ── 대시보드: 추천 수락률/DAU 슬라이스(GET /api/v1/admin/metrics) ──────────────
// 이 슬라이스에는 hasLogs 같은 전역 표본 플래그가 없다. 지표별로 표본이 없으면
// 페이지가 null 을 담아 두므로, null 이면 '표본 없음' 이다.
export interface MetricsSlice {
  failed?: boolean;
  acceptRate?: { value: number; total: number; accepted: number } | null;
  activeUsers?: number | null;
}

export function metricsMetric<T>(
  slice: MetricsSlice | null,
  pick: (s: MetricsSlice) => T | null | undefined,
): AdminMetric<T> {
  if (slice === null) return { status: 'loading' };
  if (slice.failed) return { status: 'failed' };
  const value = pick(slice);
  if (value === null || value === undefined) return { status: 'empty' };
  return { status: 'ok', value };
}

// ── 대시보드: 전일 대비 변화율 배지 ───────────────────────────────────────────
/**
 * 변화율 배지의 표시 문자열과 색조.
 *
 * flat(정확히 0)을 증가/감소와 다른 색으로 분리하는 이유: 백엔드(admin.py
 * get_dashboard_today)는 **전일 로그가 아예 없을 때도 changePercent 를 0.0 으로**
 * 내려보낸다. 즉 0 은 '변화 없음' 일 수도, '비교 기준 없음' 일 수도 있다.
 * 클라이언트에서는 둘을 구분할 근거가 없으므로, 최소한 '감소(초록)' 로 오독되지
 * 않게 중립색으로 빼고 툴팁에서 그 애매함을 밝힌다.
 */
export type ChangeTone = 'decrease' | 'increase' | 'flat';

export function changeBadge(changePercent: number): { text: string; tone: ChangeTone } {
  if (!Number.isFinite(changePercent)) return { text: '—', tone: 'flat' };
  if (changePercent < 0) return { text: `${changePercent}%`, tone: 'decrease' };
  if (changePercent > 0) return { text: `+${changePercent}%`, tone: 'increase' };
  return { text: '0%', tone: 'flat' };
}

// ── 인프라 화면: 시설 한 곳의 최신 혼잡 상태 ──────────────────────────────────
/**
 * 'unavailable'(혼잡도 조회 실패)과 'none'(아직 관측도 추정도 없음)은 다른 사실이다.
 * 예전 코드는 둘 다 level=0 으로 만들어 '한산' 으로 그렸다.
 *
 * 2026-10-07(I72): 관광객 지도와 관제 대시보드는 공영주차 기반 **추정**으로 돌아가는데, 장소 관리 목록만
 * 현장 관측(제보·좌석 방송·수동 입력)만 봐서 거의 모든 행이 '관측 대기' 였다. 그리고 9/27 의 수동 입력 한 건이
 * 열흘 뒤에도 '현재 상태' 로 서 있었다. 그래서
 *   · 'observed' = 24시간 안의 현장 관측(관광객 화면과 같은 신선도 규칙),
 *   · 'estimated' = 관측이 없거나 오래됐고 같은 추정 피드(/congestion/estimates)에 값이 있을 때,
 *   · 'stale' = 오래된 관측만 있을 때(현재 상태가 아니다 — 날짜와 함께 따로 적는다).
 */
export type FacilityCongestion =
  | { kind: 'observed'; level: number }
  | { kind: 'estimated'; level: number; previous?: StaleObservation | null }
  | { kind: 'stale'; previous: StaleObservation }
  | { kind: 'none' }
  | { kind: 'unavailable' };

/** 현재 상태로 쓰지 않는 지난 관측(값 · 관측 시각 ISO). */
export interface StaleObservation {
  level: number;
  observedAt: string;
}

/** 현장 관측이 '지금 상태' 로 읽혀도 되는 최대 나이 — 관광객 화면(lib/congestionEstimate.ts)과 같은 24시간. */
export const CURRENT_OBSERVATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** 최신 관측 1건 + 추정 1건 → 이 시설의 표시 상태. 조회 실패는 failed=true 로 넘긴다(추정이 있어도 덮지 않는다). */
export function facilityCongestionFrom(input: {
  failed: boolean;
  observedLevel: number | null | undefined;
  observedAt: string | null | undefined;
  estimateLevel: number | null | undefined;
  now: number;
}): FacilityCongestion {
  if (input.failed) return { kind: 'unavailable' };
  const level = typeof input.observedLevel === 'number' && Number.isFinite(input.observedLevel) ? input.observedLevel : null;
  const at = input.observedAt ? new Date(input.observedAt).getTime() : Number.NaN;
  const ageOk = Number.isFinite(at) && input.now - at <= CURRENT_OBSERVATION_MAX_AGE_MS;
  if (level !== null && ageOk) return { kind: 'observed', level };
  const previous: StaleObservation | null =
    level !== null && input.observedAt && Number.isFinite(at) ? { level, observedAt: input.observedAt } : null;
  const estimate = typeof input.estimateLevel === 'number' && Number.isFinite(input.estimateLevel) ? input.estimateLevel : null;
  if (estimate !== null) return { kind: 'estimated', level: estimate, previous };
  if (previous) return { kind: 'stale', previous };
  return { kind: 'none' };
}

export type FacilityStatusKey = 'orange' | 'yellow' | 'green' | 'blue' | 'unknown';

function gradeKey(level: number): Exclude<FacilityStatusKey, 'unknown'> {
  if (level >= 0.75) return 'orange';
  if (level >= 0.5) return 'yellow';
  if (level >= 0.25) return 'green';
  return 'blue';
}

const GRADE_LABEL: Record<Exclude<FacilityStatusKey, 'unknown'>, string> = {
  orange: '혼잡',
  yellow: '보통',
  green: '여유',
  blue: '한산',
};

/** 상태 점 색 키. 지금 상태를 모르면(관측·추정 없음, 오래된 관측뿐, 조회 실패) 어떤 혼잡 등급에도 넣지 않는다. */
export function facilityStatusKey(c: FacilityCongestion): FacilityStatusKey {
  if (c.kind !== 'observed' && c.kind !== 'estimated') return 'unknown';
  return gradeKey(c.level);
}

/** 사람이 읽는 상태 라벨. 추정은 '· 추정' 을 붙이고, 지금 상태를 모르면 빈 문자열(라벨 없음)이다.
 *  조회 실패만 '혼잡도 갱신 중' 이라고 적는다. */
export function facilityStatusLabel(c: FacilityCongestion): string {
  if (c.kind === 'unavailable') return '혼잡도 갱신 중';
  if (c.kind === 'observed') return GRADE_LABEL[gradeKey(c.level)];
  if (c.kind === 'estimated') return `${GRADE_LABEL[gradeKey(c.level)]} · 추정`;
  return '';
}

/** 지난 관측 한 줄('9/27 14:05 관측 혼잡 82%', KST) — 현재 상태가 아닌 관측을 날짜와 함께 적는다. 없으면 null. */
export function staleObservationLine(c: FacilityCongestion): string | null {
  const prev = c.kind === 'stale' ? c.previous : c.kind === 'estimated' ? c.previous ?? null : null;
  if (!prev) return null;
  const k = new Date(new Date(prev.observedAt).getTime() + 9 * 60 * 60 * 1000);
  const hh = String(k.getUTCHours()).padStart(2, '0');
  const mm = String(k.getUTCMinutes()).padStart(2, '0');
  return `${k.getUTCMonth() + 1}/${k.getUTCDate()} ${hh}:${mm} 관측 ${GRADE_LABEL[gradeKey(prev.level)]} ${Math.round(prev.level * 100)}%`;
}

/** 지금 관측된 혼잡도만 숫자로 돌려준다(추정·오래된 관측·미관측·실패는 null — 0 으로 대체하지 않는다). */
export function observedLevel(c: FacilityCongestion): number | null {
  return c.kind === 'observed' ? c.level : null;
}

// ── 청크 분할 ────────────────────────────────────────────────────────────────
/**
 * id 목록을 size 개씩 자른다.
 *
 * 필요한 이유: PostgREST 는 단일 응답 행수를 기본 1000 으로 캡한다(RPC 의 setof
 * 반환도 같다). 시설이 1,600곳을 넘으므로 한 번에 던지면 조용히 잘린다.
 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`chunk size 는 1 이상의 정수여야 합니다: ${size}`);
  }
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
