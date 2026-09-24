// 관리자 대시보드 '예측' · '시나리오' 모드 — 순수 함수 모음(렌더 없음, window 접근 없음, SSR 안전).
//
// 왜 필요한가(2026-09-22 PM 결정): 대시보드의 카드 대부분이 '실측' 으로 설계돼 있는데 실측이 아직
// 쌓이지 않아 매일 빈 카드이거나 '수집 중' 이다. 기존 엔진(서버 추정·실측 집계)은 그대로 두고,
// **실측이 없는 자리에만** 결정적으로 계산한 값을 라벨과 함께 채운다. 실측이 쌓이면 실측이 이긴다.
//
// 이 화면이 쓰는 비실측 어휘 세 가지(서로 섞지 않는다):
//   · '추정'   — 서버(congestion_estimator_service)가 공영주차 실측 + 관광공사 집중률로 읽을 때
//                계산한 오늘 집계. 이 모듈은 건드리지 않는다(lib/adminEstimateView.ts).
//   · '예측'   — 업종별 시간대 곡선 × 요일 계수 × (오늘 추정에서 뽑은 앵커). 상수는
//                apps/api/app/services/spot/industry_baseline.py 의 _PREDICTED_* 를 **숫자 그대로**
//                옮겼다(서버 카드의 'AI 예측' 과 같은 곡선 — 두 화면이 다른 예측을 말하지 않게).
//   · '시나리오' — 모델 입력이 아예 없는 KPI(수락률·DAU·재배치·절감 분·깔때기). 단일 출처
//                lib/demoFixtures.ts 의 하루 총량 × 시각 진행률(cumulativeDayShare) 이라 하루 동안
//                결정적으로 올라간다(비율은 고정, 건수만 증가).
//
// 전환 규칙(MIN_MEASURED_SAMPLES): 패널 자기 창에 실측 표본이 5건 이상이면 실측, 아니면 가장 높은
// 비실측 근거(추정 > 예측 > 시나리오)를 **항상 배지와 함께** 보여 준다. 실측이 1~4건이면 그 수를
// 부제에 적는다('실측 3건 수집 중') — 0건을 지어내지 않고, 4건을 실측으로 팔지도 않는다.
// 5 는 서버(admin.py get_dashboard_today: 로그 5건 미만이면 hasLogs=false)와 같은 하한이다.
//
// 이 모듈이 하지 않는 것: 서버 호출·DB 쓰기·React. 조회 실패는 여기까지 오지 않는다 — 실패는
// 페이지가 '갱신 중' 으로 그린다. 예측은 **데이터의 부재**를 채우지 서버의 부재를 채우지 않는다.
import { DEMO_ADMIN_ALTERNATIVES, DEMO_ADMIN_KPI, DEMO_ADMIN_SCENARIO_DAY } from './demoFixtures';
import type { CongestionDay } from './dashboardFallback';

// ── 라벨·상수 ────────────────────────────────────────────────────────────────

/** 예측 값 옆에 붙는 배지 문구 — 한 곳에서만 정한다(추정은 adminEstimateView.ESTIMATE_BADGE). */
export const PREDICTED_BADGE = '예측';
/** 시나리오 값 옆에 붙는 배지 문구. */
export const SCENARIO_BADGE = '시나리오';
/** 실측 값의 배지 문구(실측에는 보통 배지를 달지 않지만 CSV·툴팁이 같은 어휘를 쓴다). */
export const MEASURED_BADGE = '실측';

/** 패널이 '실측' 으로 전환되는 표본 하한 — 서버의 hasLogs 하한(5건 미만 → 표본 부족)과 같은 수. */
export const MIN_MEASURED_SAMPLES = 5;

/** 히트맵에 예측으로 채우는 업종당 최대 시설 수(정원 내림차순 → 이름 오름차순으로 결정적 선택). */
export const HEATMAP_PLACE_CAP = 12;

/** 히트맵 카테고리 탭 순서 — components/admin/DashboardCharts.tsx HEATMAP_CATEGORIES 의 id 미러. */
export const HEATMAP_TYPES = ['restaurant', 'cafe', 'attraction', 'culture'] as const;

/** 예측 '이상 혼잡' 임계치 — 실측·추정과 같은 90%. */
export const PREDICTED_ANOMALY_THRESHOLD = 0.9;

/** KST 요일 라벨(월=0 … 일=6 — 파이썬 datetime.weekday() 와 같은 순서). */
export const KST_WEEKDAY_LABELS = ['월', '화', '수', '목', '금', '토', '일'] as const;

// ── industry_baseline.py 이식(숫자 그대로) ──────────────────────────────────
// 출처: apps/api/app/services/spot/industry_baseline.py — _PREDICTED_PEAK_BY_TYPE,
// _PREDICTED_HOUR_SHAPE, _PREDICTED_HOUR_SHAPE_DEFAULT, _PREDICTED_WEEKDAY_FACTOR,
// get_predicted_baseline_congestion. 서버 값을 바꾸면 여기도 같이 바꾼다(두 화면이 다른 예측을
// 말하면 안 된다). 이 값은 어떤 시설을 측정한 것이 아니라 업종의 일반적 하루 패턴이다.

/** 업종별 '가장 붐비는 시각(주말 피크)' 의 예측 혼잡도(0..1). */
export const PREDICTED_PEAK_BY_TYPE: Record<string, number> = {
  restaurant: 0.85,
  cafe: 0.72,
  attraction: 0.8,
  culture: 0.62,
};
export const PREDICTED_PEAK_DEFAULT = 0.68;

/** 업종별 KST 시각(0~23)의 피크 대비 비율(0..1). 식당=점심·저녁, 카페=오후, 관광지·문화=한낮. */
export const PREDICTED_HOUR_SHAPE: Record<string, readonly number[]> = {
  restaurant: [
    0.05, 0.04, 0.03, 0.03, 0.03, 0.04, 0.08, 0.15, 0.22, 0.28,
    0.40, 0.65, 1.00, 0.95, 0.55, 0.42, 0.45, 0.65, 0.95, 1.00,
    0.88, 0.60, 0.35, 0.15,
  ],
  cafe: [
    0.05, 0.04, 0.03, 0.03, 0.03, 0.05, 0.10, 0.20, 0.32, 0.45,
    0.58, 0.68, 0.78, 0.88, 0.96, 1.00, 0.95, 0.85, 0.72, 0.60,
    0.48, 0.35, 0.22, 0.10,
  ],
  attraction: [
    0.03, 0.02, 0.02, 0.02, 0.02, 0.03, 0.08, 0.18, 0.35, 0.55,
    0.72, 0.86, 0.92, 0.96, 1.00, 0.95, 0.82, 0.62, 0.42, 0.26,
    0.16, 0.09, 0.05, 0.03,
  ],
  culture: [
    0.03, 0.02, 0.02, 0.02, 0.02, 0.03, 0.05, 0.12, 0.30, 0.52,
    0.72, 0.86, 0.92, 0.96, 1.00, 0.94, 0.78, 0.52, 0.22, 0.10,
    0.07, 0.05, 0.04, 0.03,
  ],
};
/** 알 수 없는 업종의 기본 곡선(완만한 주간 피크). */
export const PREDICTED_HOUR_SHAPE_DEFAULT: readonly number[] = [
  0.05, 0.04, 0.03, 0.03, 0.03, 0.05, 0.10, 0.20, 0.35, 0.50,
  0.62, 0.72, 0.80, 0.82, 0.80, 0.75, 0.68, 0.58, 0.48, 0.38,
  0.28, 0.20, 0.12, 0.07,
];
/** 요일 효과(KST, 월=0 … 일=6). 주말이 가장 붐비고 평일이 한산하다. */
export const PREDICTED_WEEKDAY_FACTOR: readonly number[] = [0.70, 0.70, 0.72, 0.75, 0.85, 1.00, 0.98];

/** 같은 업종 시설끼리 격자 행이 완전히 같지 않게 하는 결정적 시설별 폭(±10%).
 *  이름 해시로만 정해지므로 렌더마다·기기마다 같다. 곡선 자체(위 상수)는 건드리지 않는다. */
export const PREDICTED_FACILITY_SPREAD = 0.1;

/** 앵커(오늘 추정 ÷ 곡선) 허용 범위 — 추정이 한쪽으로 튀어도 예측이 곡선을 완전히 잃지 않게. */
export const ANCHOR_MIN = 0.5;
export const ANCHOR_MAX = 1.5;

// ── 타입 ────────────────────────────────────────────────────────────────────

/** 히트맵 칸 하나의 근거. */
export type CellBasis = 'measured' | 'estimate' | 'predicted';
/** 값 하나의 근거 어휘(배지·CSV·부제가 같은 네 단어를 쓴다). */
export type BasisKind = 'measured' | 'estimate' | 'predicted' | 'scenario';
/** 모델 입력이 없는 KPI(수락률·DAU·재배치·절감 분·깔때기)의 두 갈래. */
export type KpiBasis = 'measured' | 'scenario';

/** 서버 히트맵 셀(page.tsx · DashboardCharts.tsx 의 HeatmapCell 과 같은 모양). value null = 그 시간 로그 없음. */
export interface HeatmapCellInput {
  facility: string;
  facilityType: string;
  hour: number;
  value: number | null;
}
/** 근거가 붙은 히트맵 셀 — DashboardHeatmap 이 basis==='predicted' 칸을 빗금으로 그린다. */
export interface PredictedHeatmapCell extends HeatmapCellInput {
  basis: CellBasis;
}
/** 예측 행을 만들 시설(facilities 표의 name/type/capacity 만). */
export interface FacilityLite {
  name: string;
  type: string;
  capacity?: number | null;
}

/** KST 벽시계 조각. weekday 는 월=0 … 일=6(industry_baseline.py 의 moment.weekday() 와 같다). */
export interface KstParts {
  dateKst: string;
  hour: number;
  minute: number;
  weekday: number;
  /** 하루 진행률 0..1 (분 단위). */
  dayFraction: number;
}

/** 예측 집계의 근거 — 배너·CSV·툴팁이 이 값으로 문장을 만든다(adminEstimateView.predictedBasisLine). */
export interface PredictedBasisInfo {
  /** 예측 행이 된 시설 수. */
  placeCount: number;
  /** 지나간 시간 수(0시부터 현재 시까지, 현재 시 포함). */
  elapsedHours: number;
  /** 오늘 추정에서 뽑은 앵커 배율. 추정이 없으면 undefined(곡선 그대로). */
  anchor?: number;
  weekday: number;
}

/** 형 호환 예측 하루 집계 — congestionMetric()/히트맵/알림에 그대로 넘긴다(EstimatedDay 와 같은 관계). */
export interface PredictedDay extends CongestionDay {
  hasLogs: true;
  dateKst: string;
  predicted: true;
  heatmap: PredictedHeatmapCell[];
  anomalies: PredictedAlert[];
  info: PredictedBasisInfo;
}

/** 예측 피크 한 건 — page.tsx 의 AnomalyAlert 모양(id·facilityName·timestamp·congestionLevel·durationMinutes). */
export interface PredictedAlert {
  id: string;
  facilityName: string;
  timestamp: string;
  congestionLevel: number;
  durationMinutes: number;
  hour: number;
}

export interface PredictedPeak {
  facility: string;
  facilityType: string;
  hour: number;
  value: number;
}

// ── 시각 ────────────────────────────────────────────────────────────────────

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const pad2 = (n: number) => String(n).padStart(2, '0');

/** now(ms 또는 Date) → KST 벽시계 조각. 브라우저 TZ 에 맡기지 않고 +9h 고정 환산(dashboardFallback 과 같은 규칙). */
export function kstParts(now: Date | number): KstParts {
  const ms = typeof now === 'number' ? now : now.getTime();
  const k = new Date(ms + KST_OFFSET_MS);
  const hour = k.getUTCHours();
  const minute = k.getUTCMinutes();
  return {
    dateKst: `${k.getUTCFullYear()}-${pad2(k.getUTCMonth() + 1)}-${pad2(k.getUTCDate())}`,
    hour,
    minute,
    // JS getUTCDay: 일=0 … 토=6 → 파이썬 weekday: 월=0 … 일=6.
    weekday: (k.getUTCDay() + 6) % 7,
    dayFraction: (hour * 60 + minute) / (24 * 60),
  };
}

/** 'YYYY-MM-DD'(KST) 의 hour 시 정각 → UTC ISO. 예측 피크의 timestamp 를 만들 때 쓴다. */
export function kstHourToIso(dateKst: string, hour: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKst);
  if (!m) return new Date(NaN).toString();
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour, 0, 0, 0) - KST_OFFSET_MS).toISOString();
}

// ── 업종 정규화(predict_service.normalize_facility_type 이식) ─────────────────

const TYPE_ALIASES: Record<string, string> = {
  음식점: 'restaurant', 식당: 'restaurant', cafeteria: 'restaurant',
  카페: 'cafe', coffee: 'cafe',
  관광지: 'attraction', 명소: 'attraction', sight: 'attraction',
  문화시설: 'culture', 박물관: 'culture', museum: 'culture',
};

export function normalizeFacilityType(facilityType: string | null | undefined): string {
  if (!facilityType) return 'unknown';
  return TYPE_ALIASES[facilityType] ?? facilityType;
}

// ── 예측 곡선 ────────────────────────────────────────────────────────────────

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const round3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * 업종·KST 시각·요일 기반 예측 혼잡도(0..1) — get_predicted_baseline_congestion 과 같은 식에
 * 앵커(오늘 추정 ÷ 곡선 평균)를 곱한 것. anchor 를 주지 않으면 서버 값과 정확히 같다.
 */
export function predictedLevel({
  facilityType,
  kstHour,
  weekday,
  anchor = 1,
}: {
  facilityType: string;
  kstHour: number;
  weekday: number;
  anchor?: number;
}): number {
  const type = normalizeFacilityType(facilityType);
  const peak = PREDICTED_PEAK_BY_TYPE[type] ?? PREDICTED_PEAK_DEFAULT;
  const shape = PREDICTED_HOUR_SHAPE[type] ?? PREDICTED_HOUR_SHAPE_DEFAULT;
  const hour = ((Math.trunc(kstHour) % 24) + 24) % 24;
  const wd = ((Math.trunc(weekday) % 7) + 7) % 7;
  const level = peak * shape[hour] * PREDICTED_WEEKDAY_FACTOR[wd] * anchor;
  return round3(clamp01(level));
}

/** 시설 이름 → [1-spread, 1+spread] 의 결정적 배율(FNV-1a 32bit). 같은 이름은 언제나 같은 값. */
export function facilitySpread(name: string, spread: number = PREDICTED_FACILITY_SPREAD): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i += 1) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const unit = (h % 10_000) / 10_000; // 0..1
  return 1 - spread + 2 * spread * unit;
}

/** 시설 한 곳·한 시간의 예측 칸 값 — 곡선 × 앵커 × 시설별 폭. */
function predictedCellValue(facility: string, facilityType: string, hour: number, weekday: number, anchor: number | undefined): number {
  const base = predictedLevel({ facilityType, kstHour: hour, weekday, anchor: anchor ?? 1 });
  return round3(clamp01(base * facilitySpread(facility)));
}

/**
 * 오늘 추정(서버 estimated.heatmap)에서 예측 앵커를 뽑는다:
 *   mean(지나간 시간의 추정값) ÷ mean(같은 시설·같은 시간의 곡선값), [0.5, 1.5] 로 클램프.
 * 추정 값이 하나도 없으면 undefined(곡선 그대로 — 앵커를 지어내지 않는다).
 */
export function anchorFromEstimate(estimateRows: readonly HeatmapCellInput[], now: Date | number): number | undefined {
  const { hour: nowHour, weekday } = kstParts(now);
  let estimateSum = 0;
  let curveSum = 0;
  let n = 0;
  for (const row of estimateRows) {
    if (row.value === null || !Number.isFinite(row.value) || row.hour > nowHour) continue;
    estimateSum += row.value;
    curveSum += predictedLevel({ facilityType: row.facilityType, kstHour: row.hour, weekday });
    n += 1;
  }
  if (n === 0 || curveSum <= 0) return undefined;
  const ratio = (estimateSum / n) / (curveSum / n);
  return round3(Math.max(ANCHOR_MIN, Math.min(ANCHOR_MAX, ratio)));
}

// ── 히트맵 채우기 ────────────────────────────────────────────────────────────

/** facilities 목록 → 정규화한 업종별 묶음(fillHeatmapPredicted 의 facilitiesByType 입력). */
export function groupFacilitiesByType(list: readonly FacilityLite[]): Record<string, FacilityLite[]> {
  const out: Record<string, FacilityLite[]> = {};
  for (const f of list) {
    if (!f || typeof f.name !== 'string' || !f.name) continue;
    const type = normalizeFacilityType(f.type);
    (out[type] ??= []).push(f);
  }
  return out;
}

/** 업종 안에서 예측 행이 될 시설 — 정원 내림차순 → 이름 오름차순, 같은 이름은 한 번, 최대 cap. */
export function topFacilities(list: readonly FacilityLite[], cap: number = HEATMAP_PLACE_CAP): FacilityLite[] {
  const capacityOf = (f: FacilityLite) => (typeof f.capacity === 'number' && Number.isFinite(f.capacity) ? f.capacity : -1);
  const sorted = [...list].sort((a, b) => capacityOf(b) - capacityOf(a) || a.name.localeCompare(b.name, 'ko'));
  const seen = new Set<string>();
  const out: FacilityLite[] = [];
  for (const f of sorted) {
    if (seen.has(f.name)) continue;
    seen.add(f.name);
    out.push(f);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * 서버 히트맵 행(실측 또는 추정)에 예측 칸을 **빈 자리에만** 채운다.
 *   · 이미 값이 있는 칸은 절대 덮어쓰지 않는다(basis = rowsBasis).
 *   · 행이 있는 시설의 **아직 오지 않은 시간**(현재 시 이후) 빈 칸 → 예측.
 *     지나간 시간의 빈 칸은 그대로 둔다('수집 중' — 지나간 시간을 예측으로 메우면 관측 공백이 사라진다).
 *   · 서버 행에 **없는 업종**은 facilitiesByType 에서 상위 HEATMAP_PLACE_CAP 곳을 골라 0~23시 전부 예측.
 * rows 가 비어 있으면(예측 단독 모드) 네 업종 전부 예측으로 채운다.
 */
export function fillHeatmapPredicted({
  rows,
  facilitiesByType,
  now,
  anchor,
  rowsBasis = 'estimate',
}: {
  rows: readonly HeatmapCellInput[];
  facilitiesByType: Record<string, readonly FacilityLite[]>;
  now: Date | number;
  anchor?: number;
  /** rows 가 무엇인가 — 오늘 실측이면 'measured', 서버 추정이면 'estimate'. */
  rowsBasis?: 'measured' | 'estimate';
}): PredictedHeatmapCell[] {
  const { hour: nowHour, weekday } = kstParts(now);
  const out: PredictedHeatmapCell[] = [];
  const typesPresent = new Set<string>();
  const hoursByFacility = new Map<string, { facilityType: string; hours: Set<number> }>();

  for (const row of rows) {
    if (!row || typeof row.facility !== 'string' || !Number.isInteger(row.hour)) continue;
    const type = normalizeFacilityType(row.facilityType);
    typesPresent.add(type);
    const entry = hoursByFacility.get(row.facility) ?? { facilityType: row.facilityType, hours: new Set<number>() };
    hoursByFacility.set(row.facility, entry);
    if (row.value === null && row.hour > nowHour) {
      // 아직 오지 않은 시간의 빈 칸 → 예측. 값이 있는 칸은 아래 else 로 간다(덮어쓰지 않는다).
      entry.hours.add(row.hour);
      out.push({ ...row, value: predictedCellValue(row.facility, row.facilityType, row.hour, weekday, anchor), basis: 'predicted' });
      continue;
    }
    entry.hours.add(row.hour);
    out.push({ ...row, basis: rowsBasis });
  }
  // 서버가 아예 싣지 않은 미래 시간 칸(행 자체가 없음)도 예측으로 만든다.
  for (const [facility, entry] of hoursByFacility) {
    for (let hour = nowHour + 1; hour < 24; hour += 1) {
      if (entry.hours.has(hour)) continue;
      out.push({ facility, facilityType: entry.facilityType, hour, value: predictedCellValue(facility, entry.facilityType, hour, weekday, anchor), basis: 'predicted' });
    }
  }
  // 서버 행에 없는 업종은 시설 목록에서 상위 N 곳을 골라 하루 전부 예측.
  for (const type of HEATMAP_TYPES) {
    if (typesPresent.has(type)) continue;
    for (const f of topFacilities(facilitiesByType[type] ?? [])) {
      if (hoursByFacility.has(f.name)) continue;
      for (let hour = 0; hour < 24; hour += 1) {
        out.push({ facility: f.name, facilityType: type, hour, value: predictedCellValue(f.name, type, hour, weekday, anchor), basis: 'predicted' });
      }
    }
  }
  return out;
}

// ── 예측 요약·피크 ───────────────────────────────────────────────────────────

const isPredictedCell = (c: HeatmapCellInput & { basis?: CellBasis }) => (c.basis ?? 'predicted') === 'predicted';

/**
 * 예측 칸 중 임계치 이상인 피크 — 시설당 최고 한 칸, 값 내림차순 → 시각 오름차순 → 이름, 최대 limit.
 * 서버가 이미 낸 추정·실측 알림과 겹치지 않도록 basis==='predicted' 칸만 본다.
 */
export function predictedPeaks({
  rows,
  fromHour = 0,
  threshold = PREDICTED_ANOMALY_THRESHOLD,
  limit = 6,
}: {
  rows: readonly (HeatmapCellInput & { basis?: CellBasis })[];
  fromHour?: number;
  threshold?: number;
  limit?: number;
}): PredictedPeak[] {
  const best = new Map<string, PredictedPeak>();
  for (const c of rows) {
    if (!isPredictedCell(c) || c.value === null || c.value < threshold || c.hour < fromHour) continue;
    const prev = best.get(c.facility);
    if (!prev || c.value > prev.value || (c.value === prev.value && c.hour < prev.hour)) {
      best.set(c.facility, { facility: c.facility, facilityType: c.facilityType, hour: c.hour, value: c.value });
    }
  }
  return [...best.values()]
    .sort((a, b) => b.value - a.value || a.hour - b.hour || a.facility.localeCompare(b.facility, 'ko'))
    .slice(0, Math.max(0, limit));
}

/**
 * 예측 칸의 '오늘 지금까지' 요약 — 서버 집계와 같은 정의(KST 00:00 ~ 현재 시까지의 평균).
 * avgCongestion 은 지나간 시간의 예측 칸이 하나도 없으면 null(0 을 만들지 않는다).
 * anomalyCount 단위는 '(시설 × 1시간) 구간' — 실측 '건', 추정 '(장소 × 10분) 구간' 과 다르다.
 */
export function predictedDaySummary({
  rows,
  now,
}: {
  rows: readonly (HeatmapCellInput & { basis?: CellBasis })[];
  now: Date | number;
}): { avgCongestion: number | null; anomalyCount: number; placeCount: number; elapsedHours: number } {
  const { hour: nowHour } = kstParts(now);
  const places = new Set<string>();
  let sum = 0;
  let n = 0;
  let anomalyCount = 0;
  for (const c of rows) {
    if (!isPredictedCell(c) || c.value === null) continue;
    places.add(c.facility);
    if (c.hour > nowHour) continue;
    sum += c.value;
    n += 1;
    if (c.value >= PREDICTED_ANOMALY_THRESHOLD) anomalyCount += 1;
  }
  return {
    avgCongestion: n > 0 ? round3(sum / n) : null,
    anomalyCount,
    placeCount: places.size,
    elapsedHours: nowHour + 1,
  };
}

/**
 * 예측 단독 모드의 하루 집계 — resolveDashboardView(res, predictedDay) 두 번째 인자.
 * 예측 칸이 하나도 없으면(시설 목록이 아직 없거나 비어 있음) null → 기존 폴백 판정으로 간다.
 * 전일 비교는 싣지 않는다(changePercentOrNull: null — 예측끼리의 비교를 '변화율' 로 팔지 않는다).
 */
export function predictedDay({
  rows,
  now,
  anchor,
}: {
  rows: readonly PredictedHeatmapCell[];
  now: Date | number;
  anchor?: number;
}): PredictedDay | null {
  const { dateKst, weekday } = kstParts(now);
  const summary = predictedDaySummary({ rows, now });
  if (summary.avgCongestion === null) return null;
  const anomalies: PredictedAlert[] = predictedPeaks({ rows, fromHour: 0 }).map((p) => ({
    id: `predicted-${p.facility}-${p.hour}`,
    facilityName: p.facility,
    timestamp: kstHourToIso(dateKst, p.hour),
    congestionLevel: p.value,
    durationMinutes: 60,
    hour: p.hour,
  }));
  return {
    hasLogs: true,
    dateKst,
    predicted: true,
    avgCongestion: { value: summary.avgCongestion, changePercent: 0, changePercentOrNull: null, prevSampleCount: 0 },
    anomalyCount: summary.anomalyCount,
    heatmap: rows.filter((c) => c.basis === 'predicted'),
    anomalies,
    sourceComposition: null,
    info: { placeCount: summary.placeCount, elapsedHours: summary.elapsedHours, anchor, weekday },
  };
}

// ── 시나리오 KPI ─────────────────────────────────────────────────────────────

const ATTRACTION_SHAPE = PREDICTED_HOUR_SHAPE.attraction;
const ATTRACTION_SHAPE_TOTAL = ATTRACTION_SHAPE.reduce((s, v) => s + v, 0);

/**
 * KST 하루의 누적 진행 몫(0..1) — 관광지 시간대 곡선을 분 단위로 적분해 총량으로 나눈 값.
 * 00:00 에 0, 하루 안에서 단조 증가, 24:00 에 1. 시나리오 건수는 전부 '하루 총량 × 이 값' 이라
 * 한산한 새벽엔 천천히, 한낮엔 빠르게 올라간다(비율 지표는 이 값과 무관하게 고정).
 */
export function cumulativeDayShare(now: Date | number): number {
  const { hour, minute } = kstParts(now);
  let done = 0;
  for (let h = 0; h < hour; h += 1) done += ATTRACTION_SHAPE[h];
  done += ATTRACTION_SHAPE[hour] * (minute / 60);
  return clamp01(done / ATTRACTION_SHAPE_TOTAL);
}

export interface ScenarioKpis {
  /** 진행 몫(디버그·툴팁용). */
  share: number;
  /** 대안 수락률 — DEMO_ADMIN_ALTERNATIVES 의 moved 합 ÷ offered 합(하루 종일 고정). */
  acceptanceRate: number;
  /** 수락률 타일의 '총 N건 중 M건' — 시각 진행률을 곱한 건수. */
  acceptance: { rate: number; total: number; accepted: number };
  dau: number;
  relocations: number;
  savedWaitMinutes: number;
  funnel: { offered: number; navigated: number; arrived: number; positive: number };
}

const OFFERED_TOTAL = DEMO_ADMIN_ALTERNATIVES.reduce((s, a) => s + a.offered, 0);
const MOVED_TOTAL = DEMO_ADMIN_ALTERNATIVES.reduce((s, a) => s + a.moved, 0);

/**
 * 시나리오 KPI — demoFixtures 의 하루 총량 × cumulativeDayShare(now). 비율은 고정, 건수만 오른다.
 * 값의 출처는 오직 demoFixtures 상수다(여기서 숫자를 새로 만들지 않는다).
 */
export function scenarioKpis(now: Date | number): ScenarioKpis {
  const share = cumulativeDayShare(now);
  const scale = (total: number) => Math.round(total * share);
  const acceptanceRate = round3(MOVED_TOTAL / OFFERED_TOTAL);
  return {
    share,
    acceptanceRate,
    acceptance: { rate: acceptanceRate, total: scale(OFFERED_TOTAL), accepted: scale(MOVED_TOTAL) },
    dau: scale(DEMO_ADMIN_SCENARIO_DAY.dailyActiveUsers),
    relocations: scale(DEMO_ADMIN_KPI.dispersals),
    savedWaitMinutes: scale(DEMO_ADMIN_KPI.savedWaitMinutes),
    funnel: {
      offered: scale(OFFERED_TOTAL),
      navigated: scale(MOVED_TOTAL),
      arrived: scale(DEMO_ADMIN_KPI.dispersals),
      positive: scale(DEMO_ADMIN_SCENARIO_DAY.positiveRatings),
    },
  };
}

// ── 전환 규칙·문구 ───────────────────────────────────────────────────────────

/** 이 패널의 창에 실측 표본이 MIN_MEASURED_SAMPLES 이상이면 실측, 아니면 시나리오. null/undefined = 모름 → 시나리오. */
export function resolveKpiBasis(measuredCount: number | null | undefined): KpiBasis {
  return typeof measuredCount === 'number' && Number.isFinite(measuredCount) && measuredCount >= MIN_MEASURED_SAMPLES
    ? 'measured'
    : 'scenario';
}

/** 근거 어휘 → 배지 문구. */
export const BASIS_BADGE: Record<BasisKind, string> = {
  measured: MEASURED_BADGE,
  estimate: '추정',
  predicted: PREDICTED_BADGE,
  scenario: SCENARIO_BADGE,
};

/** 근거 어휘 → 부제의 근거 한 줄(배지 뒤에 붙는 '무엇으로 만든 값인가'). */
export const BASIS_METHOD: Record<Exclude<BasisKind, 'measured'>, string> = {
  estimate: '공영주차 실측 + 관광공사 집중률 기반',
  predicted: '업종 시간대 패턴 × 요일 계수',
  scenario: '도입 목표 패턴 × 시각 진행률',
};

/**
 * 비실측 값 아래 한 줄. 실측이면 null(기존 부제 그대로).
 *   · 실측 1~4건: '시나리오 · 도입 목표 패턴 × 시각 진행률 · 실측 3건 수집 중'
 *   · 실측 0건/모름: '시나리오 · 도입 목표 패턴 × 시각 진행률 · 실측 5건부터 자동 전환'
 * 0건을 문장에 적지 않는다(측정한 0 이 아니다).
 */
export function basisSubline({
  basis,
  measuredCount,
  unit = '건',
}: {
  basis: BasisKind;
  measuredCount?: number | null;
  unit?: string;
}): string | null {
  if (basis === 'measured') return null;
  const head = `${BASIS_BADGE[basis]} · ${BASIS_METHOD[basis]}`;
  const n = typeof measuredCount === 'number' && Number.isFinite(measuredCount) ? Math.trunc(measuredCount) : 0;
  if (n >= 1 && n < MIN_MEASURED_SAMPLES) return `${head} · 실측 ${n}${unit} 수집 중`;
  return `${head} · 실측 ${MIN_MEASURED_SAMPLES}${unit}부터 자동 전환`;
}

/** CSV 의 '근거' 칸 — 파일에는 배지가 없으므로 네 어휘를 글자로 적는다. */
export function csvBasisLabel(basis: BasisKind): string {
  return BASIS_BADGE[basis];
}
