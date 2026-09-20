// 관리자 **리포트** 화면의 일별 추정 추이 — 순수 함수 모음(렌더 없음).
//
// 왜 필요한가: `congestion_logs` 는 사실상 비어 있다(실측 2026-09-20: 전체 2,705행, 마지막
// 관측 8/20). 그래서 '통계 리포트'(최근 14일 로그)와 '성과 리포트'(30일 추이)는 둘 다
// 기간 전체가 0행이었고, 화면은 '데이터 없음' 만 그렸다.
//
// 서버는 이제 `GET /api/v1/admin/reports/estimated?days=N` 으로 **일별 추정 집계**를 준다
// (apps/api/app/services/estimated_report_service.py — 10분마다 쌓이는 공영주차 실측과
// 관광공사 집중률로 읽을 때 계산한다). 이 모듈이 그 응답을 화면이 쓸 모양으로 바꾼다.
//
// 이 모듈이 고정하는 것:
//   1) **모양을 믿지 않는다.** Vercel(웹)과 Render(API)는 배포 시점이 다르고 스테이징이 없다 —
//      옛 서버(엔드포인트 없음)·모양이 어긋난 응답이 실제로 온다. null 만이 아니라 형을 본다.
//      한 칸이라도 어긋나면 그 날을 버리지 추정 전체를 반쯤 그리지 않는다.
//   2) **추정은 인원 수를 만들지 않는다.** 이 응답에는 `current_count` 가 없다. 사람 수를
//      합산하던 칸은 0 으로 채우지 말고 `ESTIMATE_NO_HEADCOUNT_NOTE` 로 사실을 말해야 한다.
//   3) 추정을 그릴 때는 **근거 문장을 반드시 함께** 들고 다닌다 — 무엇에서, 언제부터 언제까지,
//      몇 분 간격으로, 반경 얼마. 라벨 없는 추정치는 값을 지어낸 것과 같은 크기의 거짓말이다.
//      (lib/adminEstimateView.ts 가 '오늘' 한 장에 대해 같은 일을 한다. 여기는 '여러 날' 이다.)
import { congestionKey } from './congestionScale';

/** 추정 값 옆에 붙는 배지 문구 — 대시보드와 같은 말을 쓴다. */
export { ESTIMATE_BADGE } from './adminEstimateView';

/** 인원 수를 합산하던 칸이 추정 모드에서 말해야 하는 사실. */
export const ESTIMATE_NO_HEADCOUNT_NOTE =
  '추정치에는 인원 수(명)가 없습니다 — 주차 점유율과 관광 집중률에서 계산한 0~100% 의 혼잡도이지 방문자 수가 아닙니다. 그래서 이 칸은 0 이 아니라 비워 둡니다.';

// ── 응답 형 ──────────────────────────────────────────────────────────────────

/** 서버 `basis` — 추정의 근거. 모르는 칸은 null 로 두고 문장에서 뺀다(숫자를 지어내지 않는다). */
export interface EstimatedSeriesBasis {
  /** 이 기간에 한 번에 잡힌 공영주차장 수의 최댓값. */
  lotCount: number | null;
  /** 주차장 반경(m). */
  radiusM: number | null;
  /** 표본 간격(분). 원본 버킷이 10분이라 10 은 '전부 썼다' 는 뜻이다. */
  samplingMinutes: number | null;
  /** 집계에 들어간 10분 버킷 수(표본 간격 적용 후). */
  snapshotCount: number | null;
  /** 주차장 반경 안이라 추정이 붙은 시설 수 / 전체 활성 시설 수. */
  estimatedFacilityCount: number | null;
  facilityCount: number | null;
  /** 기간의 첫/마지막 주차 관측(UTC ISO). */
  firstObservedAt: string | null;
  latestObservedAt: string | null;
  /** 산식 가중치(주차·관광). */
  parkingWeight: number | null;
  tourismWeight: number | null;
}

/** 하루 × 시설 유형의 추정 집계. */
export interface EstimatedTypeStat {
  avgCongestion: number;
  sampleCount: number;
  anomalyCount: number;
}

/** 하루치 추정 집계. `avgCongestion === null` = 그 날은 원본이 모자라 평균을 내지 않았다(0 이 아니다). */
export interface EstimatedDayPoint {
  date: string;
  avgCongestion: number | null;
  sampleCount: number;
  snapshotCount: number;
  anomalyCount: number | null;
  byType: Record<string, EstimatedTypeStat>;
}

export interface EstimatedSeries {
  days: number;
  startDateKst: string;
  endDateKst: string;
  samplingMinutes: number | null;
  /** 과거→오늘 순. 요청한 날짜가 **전부** 들어 있다(원본 없는 날은 avgCongestion=null). */
  daily: EstimatedDayPoint[];
  basis: EstimatedSeriesBasis;
  /** 평균을 낼 수 있었던 날 수. 0 이면 그릴 것이 없다. */
  observedDays: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const count = (v: unknown): number => {
  const n = num(v);
  return n !== null && n >= 0 ? n : 0;
};

function readBasis(raw: unknown): EstimatedSeriesBasis {
  const b = isRecord(raw) ? raw : {};
  const weights = isRecord(b.weights) ? b.weights : {};
  return {
    lotCount: num(b.lotCountMax),
    radiusM: num(b.radiusM),
    samplingMinutes: num(b.samplingMinutes),
    snapshotCount: num(b.snapshotCount),
    estimatedFacilityCount: num(b.estimatedFacilityCount),
    facilityCount: num(b.facilityCount),
    firstObservedAt: str(b.firstObservedAt),
    latestObservedAt: str(b.latestObservedAt),
    parkingWeight: num(weights.parking),
    tourismWeight: num(weights.tourism),
  };
}

function readTypes(raw: unknown): Record<string, EstimatedTypeStat> {
  if (!isRecord(raw)) return {};
  const out: Record<string, EstimatedTypeStat> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    const avg = num(value.avgCongestion);
    // 유형별 평균이 없으면 그 유형은 **없는 것**이다. 0 으로 채우면 '한산했다' 가 된다.
    if (avg === null) continue;
    out[key] = {
      avgCongestion: avg,
      sampleCount: count(value.sampleCount),
      anomalyCount: count(value.anomalyCount),
    };
  }
  return out;
}

/** 'YYYY-MM-DD' 인가. 날짜 칸이 깨지면 요일·정렬이 조용히 어긋나므로 형식까지 본다. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `GET /admin/reports/estimated` 응답 → 그릴 수 있는 추정 추이, 아니면 null.
 *
 * `available !== true` 면 null 이다 — 서버가 "추정을 못 냈다" 고 말한 것을 억지로 그리지 않는다.
 * 개별 날짜는 형이 어긋나면 그 **날만** 버린다(하루가 깨졌다고 30일을 잃을 이유가 없다).
 */
export function readEstimatedSeries(raw: unknown): EstimatedSeries | null {
  if (!isRecord(raw) || raw.available !== true || !Array.isArray(raw.daily)) return null;
  const startDateKst = str(raw.startDateKst);
  const endDateKst = str(raw.endDateKst);
  if (!startDateKst || !endDateKst) return null;

  const daily: EstimatedDayPoint[] = [];
  for (const row of raw.daily) {
    if (!isRecord(row)) continue;
    const date = str(row.date);
    if (!date || !ISO_DATE.test(date)) continue;
    const avg = num(row.avgCongestion);
    daily.push({
      date,
      avgCongestion: avg,
      sampleCount: count(row.sampleCount),
      snapshotCount: count(row.snapshotCount),
      anomalyCount: num(row.anomalyCount),
      byType: avg === null ? {} : readTypes(row.byType),
    });
  }
  if (daily.length === 0) return null;

  return {
    days: num(raw.days) ?? daily.length,
    startDateKst,
    endDateKst,
    samplingMinutes: num(raw.samplingMinutes),
    daily,
    basis: readBasis(raw.basis),
    observedDays: daily.filter((d) => d.avgCongestion !== null).length,
  };
}

/**
 * 추정을 그리지 **못한** 이유 한 줄(그릴 수 있으면 null).
 *
 * 추정이 기본이 된 화면에서 추정이 빠지면, 이유를 말하지 않는 한 '추정 모드가 고장났다' 로
 * 읽힌다. 옛 서버(응답 자체가 없음)면 null — 없는 기능의 고장을 보고할 이유는 없다.
 */
export function estimatedSeriesUnavailableNote(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  if (raw.available === true) return null;
  const reason = str(raw.reason);
  if (reason === 'timeout') {
    return '추정치(주차 실측 + 관광 통계) 계산이 제한 시간을 넘겨 이번에는 싣지 못했습니다 — 서버는 계산을 계속해 결과를 저장하므로 새로고침하면 대개 바로 나옵니다.';
  }
  if (reason === 'compute_failed') {
    return '추정치(주차 실측 + 관광 통계)를 계산하지 못했습니다 — 주차 원본 조회가 실패했습니다. 새로고침하면 다시 시도합니다.';
  }
  if (reason === 'bad_shape') {
    return '추정치 응답 형식을 해석하지 못해 표시하지 않았습니다.';
  }
  return '추정치(주차 실측 + 관광 통계)를 지금은 표시할 수 없습니다.';
}

// ── 근거 문장 ────────────────────────────────────────────────────────────────

function shortKst(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const kst = new Date(ms + 9 * 60 * 60 * 1000);
  return `${kst.getUTCMonth() + 1}.${String(kst.getUTCDate()).padStart(2, '0')}`;
}

/**
 * 추정 추이 아래에 붙는 근거 한 줄.
 * 예: '주차 실측(ITS 공영주차 4곳) + 관광공사 집중률 기반 추정 · 8.22~9.20 관측 · 30분 간격 1,336개 구간 · 반경 2km'
 * 서버가 근거를 못 실었으면 모르는 칸은 **빼고** 말한다.
 */
export function estimatedSeriesBasisLine(series: EstimatedSeries): string {
  const { basis } = series;
  const lots = basis.lotCount !== null ? `ITS 공영주차 ${basis.lotCount}곳` : 'ITS 공영주차';
  const parts = [`주차 실측(${lots}) + 관광공사 집중률 기반 추정`];
  const from = shortKst(basis.firstObservedAt);
  const to = shortKst(basis.latestObservedAt);
  if (from && to) parts.push(`${from}~${to} 관측`);
  const minutes = basis.samplingMinutes ?? series.samplingMinutes;
  if (minutes !== null && basis.snapshotCount !== null) {
    parts.push(`${minutes}분 간격 ${basis.snapshotCount.toLocaleString('ko-KR')}개 구간`);
  } else if (minutes !== null) {
    parts.push(`${minutes}분 간격`);
  }
  if (basis.radiusM !== null) {
    parts.push(
      basis.radiusM >= 1000
        ? `반경 ${Number((basis.radiusM / 1000).toFixed(1))}km`
        : `반경 ${basis.radiusM}m`,
    );
  }
  return parts.join(' · ');
}

/** 산식과 적용 범위 — 근거의 두 번째 줄(대시보드 배너와 같은 말). */
export function estimatedSeriesMethodNote(series: EstimatedSeries): string {
  const { basis } = series;
  const pw = basis.parkingWeight ?? 0.7;
  const tw = basis.tourismWeight ?? 0.3;
  const parts = [`혼잡도 = ${pw} × 주변 공영주차 점유율 + ${tw} × 관광공사 집중률`];
  if (basis.estimatedFacilityCount !== null && basis.facilityCount !== null) {
    parts.push(
      `활성 시설 ${basis.facilityCount.toLocaleString('ko-KR')}곳 중 ${basis.estimatedFacilityCount.toLocaleString('ko-KR')}곳이 주차장 반경 안`,
    );
  }
  parts.push('표본 1개 = (시설 × 구간)');
  return parts.join(' · ');
}

// ── 차트·표용 파생 ───────────────────────────────────────────────────────────

/** 성과 리포트의 30일 차트 1행. 측정 계열과 **같은 라벨·같은 키**라 차트 컴포넌트를 그대로 쓴다. */
export interface EstimatedTrendRow {
  date: string;
  avgCongestion: number | null;
}

/** 'YYYY-MM-DD' → 'M/D'. 측정 계열(admin/report chartRows)이 쓰는 형식 그대로. */
export function shortChartLabel(isoDate: string): string {
  const [, m, d] = isoDate.split('-');
  return `${Number(m)}/${Number(d)}`;
}

export function estimatedTrendRows(series: EstimatedSeries): EstimatedTrendRow[] {
  return series.daily.map((day) => ({
    date: shortChartLabel(day.date),
    avgCongestion: day.avgCongestion,
  }));
}

/** KST 달력 날짜의 요일. 날짜가 이미 KST 기준이라 UTC 로 만들어야 시간대가 끼어들지 않는다. */
const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'] as const;
export const WEEK_ORDER_KO = ['월', '화', '수', '목', '금', '토', '일'] as const;

export function weekdayKo(isoDate: string): string | null {
  if (!ISO_DATE.test(isoDate)) return null;
  const [y, m, d] = isoDate.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d);
  if (!Number.isFinite(ms)) return null;
  return WEEKDAY_KO[new Date(ms).getUTCDay()];
}

/** 통계 리포트 막대 차트 1행 — 요일 + 유형별 **평균 추정 혼잡도(0~1)**. */
export type WeekdayEstimateRow = { day: string; dayCount: number } & Record<string, number | string | null>;

/**
 * 요일 × 유형 평균. 실측 화면의 '합' 과 달리 **평균**인 이유: 추정치는 비율(0~1)이라 더하면
 * 시설 수를 재는 값이 된다(경주는 유형별 시설 수가 음식점 1,086 : 문화 3 이라 막대가
 * 업종 규모 그래프가 되어 버린다). 평균은 "그 요일 그 업종이 얼마나 붐볐나" 그대로다.
 *
 * 표본 가중 평균을 쓴다 — 관측 버킷이 20개인 날과 144개인 날을 같은 무게로 두면 수집이
 * 드문 날이 요일 평균을 끌고 간다.
 *
 * 값이 하나도 없는 (요일, 유형) 칸은 **null** 이다. 0 으로 채우면 '그 요일엔 한산했다' 가 된다.
 */
export function weekdayEstimateRows(
  daily: readonly EstimatedDayPoint[],
  labels: Readonly<Record<string, string>>,
): WeekdayEstimateRow[] {
  const acc = new Map<string, { sum: Map<string, number>; n: Map<string, number>; days: Set<string> }>();
  for (const weekday of WEEK_ORDER_KO) {
    acc.set(weekday, { sum: new Map(), n: new Map(), days: new Set() });
  }
  for (const day of daily) {
    if (day.avgCongestion === null) continue;
    const weekday = weekdayKo(day.date);
    const bucket = weekday ? acc.get(weekday) : undefined;
    if (!bucket) continue;
    let used = false;
    for (const [type, label] of Object.entries(labels)) {
      const stat = day.byType[type];
      if (!stat || stat.sampleCount <= 0) continue;
      bucket.sum.set(label, (bucket.sum.get(label) ?? 0) + stat.avgCongestion * stat.sampleCount);
      bucket.n.set(label, (bucket.n.get(label) ?? 0) + stat.sampleCount);
      used = true;
    }
    if (used) bucket.days.add(day.date);
  }
  return WEEK_ORDER_KO.map((weekday) => {
    const bucket = acc.get(weekday)!;
    const row: WeekdayEstimateRow = { day: weekday, dayCount: bucket.days.size };
    for (const label of Object.values(labels)) {
      const n = bucket.n.get(label) ?? 0;
      row[label] = n > 0 ? Math.round(((bucket.sum.get(label) ?? 0) / n) * 1000) / 1000 : null;
    }
    return row;
  });
}

/** 통계 리포트 요약표 1행 — 유형별 최근 창 평균과 직전 창 대비 변화. */
export interface CategoryEstimateRow {
  type: string;
  label: string;
  /** 최근 창의 표본 가중 평균(0~1). 관측이 없으면 null. */
  avgCongestion: number | null;
  /** 최근 창에서 그 유형에 값이 있던 날 수. */
  dayCount: number;
  /** 직전 같은 길이 창의 평균(없으면 null — 그때는 비교를 만들지 않는다). */
  prevAvgCongestion: number | null;
  /** 변화폭(**%포인트**, 소수 1자리). 비교 불가면 null. 비율의 증감률이 아니다. */
  changePoints: number | null;
  /** 혼잡 등급(lib/congestionScale 의 경계). 값이 없으면 null. */
  status: string | null;
}

const STATUS_KO: Record<string, string> = {
  busy: '혼잡', moderate: '보통', relaxed: '여유', quiet: '한산',
};

function weightedAverage(
  days: readonly EstimatedDayPoint[],
  type: string,
): { avg: number | null; dayCount: number } {
  let sum = 0;
  let n = 0;
  let dayCount = 0;
  for (const day of days) {
    const stat = day.byType[type];
    if (!stat || stat.sampleCount <= 0) continue;
    sum += stat.avgCongestion * stat.sampleCount;
    n += stat.sampleCount;
    dayCount += 1;
  }
  return { avg: n > 0 ? Math.round((sum / n) * 1000) / 1000 : null, dayCount };
}

/**
 * 최근 `windowDays` 일과 그 직전 같은 길이 창을 비교한 유형별 요약.
 *
 * 직전 창에 관측이 없으면 `changePoints = null` 이다 — 없는 비교를 '+100%' 로 지어내지
 * 않는다(lib/adminUsageIndex.describeGrowth 가 실측 쪽에서 지키는 것과 같은 규칙).
 */
export function categoryEstimateRows(
  daily: readonly EstimatedDayPoint[],
  labels: Readonly<Record<string, string>>,
  { windowDays = 7, busyAt }: { windowDays?: number; busyAt?: number } = {},
): CategoryEstimateRow[] {
  const recent = daily.slice(-windowDays);
  const previous = daily.slice(Math.max(0, daily.length - windowDays * 2), Math.max(0, daily.length - windowDays));
  return Object.entries(labels).map(([type, label]) => {
    const now = weightedAverage(recent, type);
    const before = weightedAverage(previous, type);
    return {
      type,
      label,
      avgCongestion: now.avg,
      dayCount: now.dayCount,
      prevAvgCongestion: before.avg,
      changePoints:
        now.avg !== null && before.avg !== null
          ? Math.round((now.avg - before.avg) * 1000) / 10
          : null,
      status: now.avg !== null ? STATUS_KO[congestionKey(now.avg, busyAt)] ?? null : null,
    };
  });
}

/** 기간 전체(표본 가중)의 평균·최고 추정 혼잡도. 성과 리포트의 '참고' 상자에 쓴다. */
export function estimatedSeriesSummary(series: EstimatedSeries): {
  avgCongestion: number | null;
  maxCongestion: number | null;
  maxDate: string | null;
  observedDays: number;
  totalDays: number;
  anomalyCount: number | null;
} {
  let sum = 0;
  let n = 0;
  let max: number | null = null;
  let maxDate: string | null = null;
  let anomalies = 0;
  let sawAnomalyCount = false;
  for (const day of series.daily) {
    if (day.avgCongestion === null || day.sampleCount <= 0) continue;
    sum += day.avgCongestion * day.sampleCount;
    n += day.sampleCount;
    if (max === null || day.avgCongestion > max) {
      max = day.avgCongestion;
      maxDate = day.date;
    }
    if (day.anomalyCount !== null) {
      anomalies += day.anomalyCount;
      sawAnomalyCount = true;
    }
  }
  return {
    avgCongestion: n > 0 ? Math.round((sum / n) * 1000) / 1000 : null,
    maxCongestion: max,
    maxDate,
    observedDays: series.observedDays,
    totalDays: series.daily.length,
    anomalyCount: sawAnomalyCount ? anomalies : null,
  };
}
