// 추천 고리 지표(수락률 · 이용자 · 재배치 · 30일 추이)를 서버 응답에서 화면 값으로 읽는 순수 함수(P0-3 · P1-1).
//
// 정의의 정본은 서버(apps/api/app/routers/admin.py)다 — 이 모듈은 다시 세지 않고 읽기만 한다:
//   · 수락률 = 수락 ÷ (수락 + 거절). 메인 화면 거절(source 'browse')까지 같은 모집단이고 내부 계정(관리자·개발자)은 뺀다.
//   · 재배치 = 수락 · 원본 ≠ 목적지 · 도착 확인. 도착 미확인·같은 장소 수락은 따로 센다.
//   · 예상 대기 차이 = 재배치 건의 Σ max(0, 원본 예상대기 − 대안 예상대기) — 모델 추정이지 측정한 절감이 아니다.
//
// 표본 하한(MIN_RATE_SAMPLES): 비율·합계를 '효과' 로 읽게 하려면 표본이 있어야 한다. 하한 미만이면 화면은 숫자 대신
// '표본 부족 · n건 / 필요 m건' 을 그린다. 운영 화면은 그 자리를 데모 값(시나리오)으로 채우지 않는다 — 시나리오는
// 데모(?demo=1) 화면 전용이다(2026-10-31, 공문서에 인용될 수 있는 화면에 지어낸 숫자를 두지 않는다).
//
// 옛 서버 응답(새 키가 없음): Render(API)는 수동 배포라 새 웹이 옛 서버를 받는 구간이 실제로 있다.
//   · 수락률 — 옛 원본 행(browse 제외 추천 행)으로 계산하되 basis='shown' 으로 표시해 화면이 '추천 n건 중' 이라고
//     말하게 한다(결정 기준인 척하지 않는다).
//   · 재배치 — 옛 서버의 relocations 는 '수락 행 수' 라 재배치로 그릴 수 없다 → null(화면은 '갱신 중').

import { MIN_MEASURED_SAMPLES } from './adminPredictedView';

/** 비율·효과 지표를 숫자로 보여 줄 최소 표본 — 서버의 하루 집계 하한(hasLogs: 5건)과 같은 수. */
export const MIN_RATE_SAMPLES = MIN_MEASURED_SAMPLES;

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const toMs = (iso: unknown): number => (typeof iso === 'string' ? Date.parse(iso) : Number.NaN);

/** n 이 하한 이상인가(숫자가 아니면 아니다). */
export function hasEnoughSamples(n: number | null | undefined, min: number = MIN_RATE_SAMPLES): boolean {
  return isCount(n) && n >= min;
}

/** '표본 부족 · 3건 / 필요 5건' — 하한 미만 자리의 문구. */
export function insufficientSampleLabel(n: number, min: number = MIN_RATE_SAMPLES, unit: string = '건'): string {
  const count = isCount(n) ? Math.trunc(n) : 0;
  return `표본 부족 · ${count.toLocaleString('ko-KR')}${unit} / 필요 ${min.toLocaleString('ko-KR')}${unit}`;
}

// ── 수락률(GET /admin/metrics) ───────────────────────────────────────────────

export interface AcceptanceView {
  accepted: number;
  /** 거절 수 — 새 서버만 안다(옛 서버면 null). */
  rejected: number | null;
  /** 비율의 분모이자 표본 수(n). basis 'decisions' = 수락 + 거절, 'shown' = 옛 서버의 추천 노출 행. */
  total: number;
  /** total 이 0 이면 null — 0% 를 지어내지 않는다. */
  rate: number | null;
  basis: 'decisions' | 'shown';
}

/**
 * /admin/metrics 응답 → 수락률. 새 키(acceptance)가 있으면 그대로, 없으면 옛 원본 행을 window 로 잘라 센다.
 * 응답 모양이 둘 다 아니면 null(화면은 '갱신 중').
 */
export function readAcceptance(res: unknown, window: { start: string; end: string }): AcceptanceView | null {
  if (!isRecord(res)) return null;
  const a = res.acceptance;
  if (isRecord(a) && isCount(a.accepted) && isCount(a.rejected) && isCount(a.decisions)) {
    return {
      accepted: a.accepted,
      rejected: a.rejected,
      total: a.decisions,
      rate: a.decisions > 0 ? a.accepted / a.decisions : null,
      basis: 'decisions',
    };
  }
  if (!Array.isArray(res.recommendations)) return null;
  const from = toMs(window.start);
  const to = toMs(window.end);
  let total = 0;
  let accepted = 0;
  for (const row of res.recommendations) {
    if (!isRecord(row)) continue;
    const at = toMs(row.created_at);
    if (!Number.isFinite(at) || at < from || at > to) continue;
    total += 1;
    if (row.accepted === true) accepted += 1;
  }
  return { accepted, rejected: null, total, rate: total > 0 ? accepted / total : null, basis: 'shown' };
}

export interface ActiveUsersView {
  /** 오늘(KST) 추천에 반응(수락·거절·평가 등)을 남긴 순 사용자 수. */
  users: number;
  /** 그 행 수 — 순 사용자 수의 표본(n). */
  events: number;
  /** 'server' = 새 서버 집계(내부 계정 제외) · 'rows' = 옛 서버 원본 행으로 센 값(내부 계정 포함). */
  basis: 'server' | 'rows';
}

/** /admin/metrics 응답 → 오늘 이용자. 새 키(active_users — 내부 계정 제외)가 없으면 옛 피드백 행으로 센다. */
export function readActiveUsers(res: unknown, window: { start: string; end: string }): ActiveUsersView | null {
  if (!isRecord(res)) return null;
  const a = res.active_users;
  if (isRecord(a) && isCount(a.users) && isCount(a.events)) return { users: a.users, events: a.events, basis: 'server' };
  if (!Array.isArray(res.feedback)) return null;
  const from = toMs(window.start);
  const to = toMs(window.end);
  const users = new Set<string>();
  let events = 0;
  for (const row of res.feedback) {
    if (!isRecord(row)) continue;
    const at = toMs(row.timestamp);
    if (!Number.isFinite(at) || at < from || at > to) continue;
    events += 1;
    if (typeof row.user_id === 'string' && row.user_id) users.add(row.user_id);
  }
  return { users: users.size, events, basis: 'rows' };
}

// ── 추천 수락 결과(GET /admin/impact) ─────────────────────────────────────────

export interface ImpactView {
  /** 재배치 — 수락 · 원본 ≠ 목적지 · 도착 확인. */
  relocations: number;
  /** 수락 전체(내부 계정 제외) — 아래 네 갈래의 합이자 표본 수. */
  acceptedTotal: number;
  movesUnconfirmed: number;
  sameFacility: number;
  missingFacility: number;
  /** 재배치 건의 예상 대기 차이 합(분, 모델 추정). */
  waitDiffMinutes: number;
  waitBasis: { waitModel: number; congestionGap: number; unavailable: number };
  excludedInternal: number;
  /** 서버 상한에 닿았다 — 위 건수·합계는 하한이다. */
  truncated: boolean;
}

/** /admin/impact 응답 → 수락 결과. 새 키가 없는 옛 서버(relocations = 수락 행 수)나 모양이 다른 응답은 null. */
export function readImpact(res: unknown): ImpactView | null {
  if (!isRecord(res)) return null;
  const basis = res.expected_wait_diff_basis;
  if (
    !isCount(res.relocations) || !isCount(res.accepted_total) || !isCount(res.accepted_moves_unconfirmed)
    || !isCount(res.accepted_same_facility) || !isCount(res.expected_wait_diff_minutes) || !isRecord(basis)
  ) {
    return null;
  }
  return {
    relocations: res.relocations,
    acceptedTotal: res.accepted_total,
    movesUnconfirmed: res.accepted_moves_unconfirmed,
    sameFacility: res.accepted_same_facility,
    missingFacility: isCount(res.accepted_missing_facility) ? res.accepted_missing_facility : 0,
    waitDiffMinutes: res.expected_wait_diff_minutes,
    waitBasis: {
      waitModel: isCount(basis.wait_model) ? basis.wait_model : 0,
      congestionGap: isCount(basis.congestion_gap) ? basis.congestion_gap : 0,
      unavailable: isCount(basis.unavailable) ? basis.unavailable : 0,
    },
    excludedInternal: isCount(res.excluded_internal) ? res.excluded_internal : 0,
    truncated: res.truncated === true,
  };
}

/** '대기 예측식 2건 · 혼잡 차이×15분 근사 1건 · 산정 불가 1건' — 예상 대기 차이가 무엇으로 계산됐는지(0건 항목은 뺀다). */
export function waitDiffBasisLine(view: Pick<ImpactView, 'waitBasis'>): string {
  const parts: string[] = [];
  if (view.waitBasis.waitModel > 0) parts.push(`대기 예측식 ${view.waitBasis.waitModel}건`);
  if (view.waitBasis.congestionGap > 0) parts.push(`혼잡 차이×15분 근사 ${view.waitBasis.congestionGap}건`);
  if (view.waitBasis.unavailable > 0) parts.push(`산정 불가 ${view.waitBasis.unavailable}건`);
  return parts.join(' · ');
}

// ── 30일 추이(GET /admin/metrics/trend) ───────────────────────────────────────

/** 추이 하루 — 새 키(decisions·accepted·rejected)는 옛 서버에 없다. */
export interface TrendDayInput {
  rec_total?: number;
  rec_accepted?: number;
  decisions?: number;
  accepted?: number;
  rejected?: number;
}

/**
 * 하루 수락률 — 그 날 결정이 하한(MIN_RATE_SAMPLES) 이상일 때만. 결정 1~2건으로 0%·100% 를 그리면 그 점이
 * 추이처럼 읽힌다. 옛 서버면 추천 노출 행 기준(같은 하한).
 */
export function dailyAcceptShare(day: TrendDayInput, min: number = MIN_RATE_SAMPLES): number | null {
  if (isCount(day.decisions) && isCount(day.accepted)) {
    return day.decisions >= min ? Math.round((day.accepted / day.decisions) * 1000) / 1000 : null;
  }
  if (isCount(day.rec_total) && isCount(day.rec_accepted)) {
    return day.rec_total >= min ? Math.round((day.rec_accepted / day.rec_total) * 1000) / 1000 : null;
  }
  return null;
}

/** 기간 합계 수락률 — 하루 키를 더한다(새 키가 하나라도 없으면 옛 기준으로 통째로 센다 — 기준을 섞지 않는다). */
export function periodAcceptance(daily: readonly TrendDayInput[]): AcceptanceView {
  const decisionsKnown = daily.length > 0 && daily.every((d) => isCount(d.decisions) && isCount(d.accepted) && isCount(d.rejected));
  if (decisionsKnown) {
    const accepted = daily.reduce((s, d) => s + (d.accepted as number), 0);
    const rejected = daily.reduce((s, d) => s + (d.rejected as number), 0);
    const total = accepted + rejected;
    return { accepted, rejected, total, rate: total > 0 ? accepted / total : null, basis: 'decisions' };
  }
  const total = daily.reduce((s, d) => s + (isCount(d.rec_total) ? d.rec_total : 0), 0);
  const accepted = daily.reduce((s, d) => s + (isCount(d.rec_accepted) ? d.rec_accepted : 0), 0);
  return { accepted, rejected: null, total, rate: total > 0 ? accepted / total : null, basis: 'shown' };
}

/** 수락률 한 줄의 표본 문구 — '결정 12건 중 5건 수락(거절 7건)' / 옛 서버 '추천 40건 중 10건 수락'. */
export function acceptanceSampleLine(view: AcceptanceView): string {
  if (view.basis === 'decisions') {
    return `결정 ${view.total.toLocaleString('ko-KR')}건 중 ${view.accepted.toLocaleString('ko-KR')}건 수락`
      + (view.rejected !== null ? `(거절 ${view.rejected.toLocaleString('ko-KR')}건)` : '');
  }
  return `추천 ${view.total.toLocaleString('ko-KR')}건 중 ${view.accepted.toLocaleString('ko-KR')}건 수락`;
}
