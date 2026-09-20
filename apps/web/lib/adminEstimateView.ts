// 관리자 대시보드 '실시간 관제' 의 **추정 모드** 판정 — 순수 함수 모음(렌더 없음).
//
// 왜 필요한가: 경주에는 시설 단위 실시간 인원 데이터가 없다. congestion_logs 는 사실상 비어
// 있어서(7월 시드 한 덩어리) 이 화면은 매일 빈 카드이거나 두 달 전 시드 날짜로 물러났다.
// 서버(admin.py get_dashboard_today)는 이제 10분마다 쌓이는 공영주차 실측(경주 ITS)과
// 관광공사 집중률로 **읽을 때 계산한 오늘의 추정 집계**를 별도 키 `estimated` 로 싣는다
// (apps/api/app/services/congestion_estimator_service.py).
//
// 이 모듈이 고정하는 것:
//   1) 그리는 순서 — 오늘 실측 → 오늘 추정 → 과거 실측(폴백). 추정이 두 달 전 시드보다 앞선다:
//      '오늘 이 시각의 추정' 이 '두 달 전의 실측' 보다 관리자가 지금 판단하는 데 쓸모 있다.
//      단, 실측이 들어오면 실측이 항상 이긴다.
//   2) 추정을 그릴 때는 **근거 문장을 반드시 함께** 들고 다닌다(무엇에서, 몇 곳, 언제, 반경).
//      라벨 없는 추정치는 값을 지어낸 것과 같은 크기의 거짓말이다.
//   3) 모양을 믿지 않는다 — Vercel(웹)과 Render(API)는 배포 시점이 달라 옛 서버(키 없음)나
//      모양이 어긋난 응답이 실제로 온다. null 만이 아니라 **형**을 가드한다(어긋나면 추정을
//      포기하고 기존 폴백으로 간다 — 화면 전체가 에러 경계로 떨어지지 않게).
import {
  basisDateBadge,
  basisPeriodLabel,
  congestionEmptyNotice,
  fallbackExplanation,
  formatKstDateTime,
  kstDate,
  resolveCongestionView,
  shortKstDate,
  type CongestionBasis,
  type CongestionDay,
  type CongestionEmptyNotice,
  type DashboardTodayResponse,
} from './dashboardFallback';

/** 서버 `estimated.basis` — 추정의 근거(congestion_estimator_service.aggregate_estimated_day). */
export interface EstimateBasisInfo {
  /** 이 스냅샷 묶음에서 한 번에 잡힌 공영주차장 수의 최댓값. */
  lotCount: number | null;
  /** 가장 최근 주차 관측(UTC ISO). */
  latestObservedAt: string | null;
  /** 주차장 반경(m). */
  radiusM: number | null;
  /** 히트맵·이상 알림의 행이 된 대표 관광지 수. */
  placeCount: number | null;
  /** 주차 반경 안이라 추정이 붙은 시설 수 / 전체 활성 시설 수. */
  estimatedFacilityCount: number | null;
  facilityCount: number | null;
  /** 오늘 쌓인 10분 스냅샷 수. */
  snapshotCount: number | null;
  /** 산식 가중치(주차·관광). */
  parkingWeight: number | null;
  tourismWeight: number | null;
}

/** 형 가드를 통과한 오늘의 추정 집계. CongestionDay 와 구조 호환이라 congestionMetric() 에 그대로 넘긴다. */
export interface EstimatedDay extends CongestionDay {
  hasLogs: true;
  dateKst: string;
  basis: EstimateBasisInfo;
}

/** 서버 응답 + 신규 키. `estimated` 는 모양을 믿지 않으므로 unknown 으로 받는다. */
export interface DashboardTodayWithEstimate extends DashboardTodayResponse {
  /** undefined = 이 키를 모르는 옛 서버, null = 추정을 못 냈다, 객체 = 추정 집계(형은 아래에서 가드). */
  estimated?: unknown;
}

/** 화면이 지금 무엇을 보고 있는가 — 기존 네 갈래 + '오늘 추정'. */
export type DashboardBasis = CongestionBasis | { kind: 'estimate'; dateKst: string; info: EstimateBasisInfo };

export interface DashboardView {
  basis: DashboardBasis;
  day: CongestionDay | null;
}

/** 추정 값 옆에 붙는 배지 문구 — 한 곳에서만 정한다. */
export const ESTIMATE_BADGE = '추정';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function readBasis(raw: unknown): EstimateBasisInfo {
  const b = isRecord(raw) ? raw : {};
  const weights = isRecord(b.weights) ? b.weights : {};
  return {
    lotCount: num(b.lotCountMax),
    latestObservedAt: str(b.latestObservedAt),
    radiusM: num(b.radiusM),
    placeCount: num(b.placeCount),
    estimatedFacilityCount: num(b.estimatedFacilityCount),
    facilityCount: num(b.facilityCount),
    snapshotCount: num(b.snapshotCount),
    parkingWeight: num(weights.parking),
    tourismWeight: num(weights.tourism),
  };
}

/**
 * `estimated` 원문 → 그릴 수 있는 추정 집계, 아니면 null.
 *
 * 하나라도 형이 어긋나면 **추정 전체를 포기**한다(부분만 그리면 평균은 추정인데 히트맵은
 * 비어 있는 식으로 카드끼리 다른 이야기를 한다). 히트맵·알림의 개별 행은 불량만 걸러 낸다.
 */
export function readEstimatedDay(raw: unknown): EstimatedDay | null {
  if (!isRecord(raw) || raw.hasLogs !== true) return null;
  const dateKst = str(raw.dateKst);
  const avg = raw.avgCongestion;
  if (!dateKst || !isRecord(avg) || num(avg.value) === null) return null;
  const anomalyCount = num(raw.anomalyCount);
  if (anomalyCount === null || !Array.isArray(raw.heatmap) || !Array.isArray(raw.anomalies)) return null;

  const heatmap = raw.heatmap.filter(
    (c): c is { facility: string; facilityType: string; hour: number; value: number | null } =>
      isRecord(c) &&
      typeof c.facility === 'string' &&
      typeof c.hour === 'number' &&
      (c.value === null || num(c.value) !== null),
  ).map((c) => ({ ...c, facilityType: typeof c.facilityType === 'string' ? c.facilityType : 'unknown' }));
  const anomalies = raw.anomalies.filter(
    (a) =>
      isRecord(a) &&
      typeof a.facilityName === 'string' &&
      typeof a.timestamp === 'string' &&
      num(a.congestionLevel) !== null,
  );
  const changePercentOrNull = avg.changePercentOrNull === null ? null : num(avg.changePercentOrNull) ?? undefined;
  return {
    hasLogs: true,
    dateKst,
    avgCongestion: {
      value: avg.value as number,
      changePercent: num(avg.changePercent) ?? 0,
      ...(changePercentOrNull !== undefined ? { changePercentOrNull } : {}),
      ...(num(avg.prevSampleCount) !== null ? { prevSampleCount: avg.prevSampleCount as number } : {}),
    },
    anomalyCount,
    heatmap,
    anomalies,
    sampleCount: num(raw.sampleCount) ?? undefined,
    sourceComposition: isRecord(raw.sourceComposition) ? (raw.sourceComposition as Record<string, number>) : null,
    basis: readBasis(raw.basis),
  };
}

/**
 * 응답 하나 → '기준' 과 '그릴 집계'. 순서: 오늘 실측 → 오늘 추정 → 과거 실측(폴백).
 *
 * 실측/실패/로딩 판정은 dashboardFallback.resolveCongestionView 에 그대로 맡긴다 — 두 벌로
 * 두면 폴백 규칙이 여기서만 조용히 갈라진다.
 */
export function resolveDashboardView(res: DashboardTodayWithEstimate | null): DashboardView {
  if (res && !res.failed && !res.hasLogs) {
    const estimated = readEstimatedDay(res.estimated);
    if (estimated) {
      return { basis: { kind: 'estimate', dateKst: estimated.dateKst, info: estimated.basis }, day: estimated };
    }
  }
  return resolveCongestionView(res);
}

// ── 화면 문구 ────────────────────────────────────────────────────────────────

/** 'HH:MM' (KST). 관측이 그 날이 아니면 'M/D HH:MM' — 어제 밤 관측을 오늘 것으로 읽히게 하지 않는다. */
function observedClock(iso: string | null, dateKst: string): string | null {
  const at = formatKstDateTime(iso);
  if (!at) return null;
  const clock = at.slice(11, 16);
  const day = kstDate(iso);
  return day && day !== dateKst ? `${shortKstDate(day)} ${clock}` : clock;
}

/**
 * 추정 값 옆에 붙는 근거 한 줄.
 * 예: '주차 실측(ITS 공영주차 4곳) + 관광공사 집중률 기반 추정 · 14:50 관측 · 반경 2km'
 * 서버가 근거를 못 실었으면 모르는 칸은 빼고 말한다(숫자를 지어내지 않는다).
 */
export function estimateBasisLine(info: EstimateBasisInfo, dateKst: string): string {
  const lots = info.lotCount !== null ? `ITS 공영주차 ${info.lotCount}곳` : 'ITS 공영주차';
  const parts = [`주차 실측(${lots}) + 관광공사 집중률 기반 추정`];
  const clock = observedClock(info.latestObservedAt, dateKst);
  if (clock) parts.push(`${clock} 관측`);
  if (info.radiusM !== null) {
    parts.push(info.radiusM >= 1000 ? `반경 ${Number((info.radiusM / 1000).toFixed(1))}km` : `반경 ${info.radiusM}m`);
  }
  return parts.join(' · ');
}

/** 산식과 적용 범위 — 배너의 두 번째 줄. */
export function estimateMethodNote(info: EstimateBasisInfo): string {
  const pw = info.parkingWeight ?? 0.7;
  const tw = info.tourismWeight ?? 0.3;
  const parts = [`혼잡도 = ${pw} × 주변 공영주차 점유율 + ${tw} × 관광공사 집중률`];
  if (info.placeCount !== null) parts.push(`대표 관광지 ${info.placeCount}곳 × 10분 구간 단위`);
  if (info.estimatedFacilityCount !== null && info.facilityCount !== null) {
    parts.push(
      `활성 시설 ${info.facilityCount.toLocaleString('ko-KR')}곳 중 ${info.estimatedFacilityCount.toLocaleString('ko-KR')}곳이 주차장 반경 안`,
    );
  }
  return parts.join(' · ');
}

/** 이상 혼잡 건수의 단위 — 실측은 '로그 1행', 추정은 '(대표 장소 × 10분) 구간' 이다. */
export const ESTIMATE_ANOMALY_UNIT = '혼잡도 90% 이상으로 추정된 (대표 관광지 × 10분) 구간 수';

/**
 * 히트맵에서 '아직 오지 않은 시간' 이 시작되는 KST 시(0..23). 없으면 null.
 * 오늘을 그릴 때만 의미가 있다 — 과거 날짜의 빈 칸은 '데이터 없음' 이지 '미래' 가 아니다.
 */
export function pendingFromHour(dateKst: string | null, nowMs: number): number | null {
  if (!dateKst) return null;
  const at = formatKstDateTime(new Date(nowMs).toISOString());
  if (!at) return null;
  const today = at.slice(0, 10);
  if (dateKst > today) return 0;
  if (dateKst < today) return null;
  const next = Number(at.slice(11, 13)) + 1;
  return next >= 24 ? null : next;
}

// ── 기존 판정 함수의 '추정' 갈래 확장 ────────────────────────────────────────
// dashboardFallback 의 함수들은 CongestionBasis 만 안다. 추정은 '오늘' 이므로 날짜 배지·폴백
// 설명은 없고(null), 기간 라벨은 '오늘' 이다.

export function dashboardPeriodLabel(basis: DashboardBasis): string {
  return basis.kind === 'estimate' ? '오늘' : basisPeriodLabel(basis);
}

export function dashboardDateBadge(basis: DashboardBasis): string | null {
  return basis.kind === 'estimate' ? null : basisDateBadge(basis);
}

export function dashboardFallbackExplanation(basis: DashboardBasis): string | null {
  return basis.kind === 'estimate' ? null : fallbackExplanation(basis);
}

/**
 * 이 지표의 원천에 행이 쌓이는 경로(화면이 '무엇을 하면 채워지는지' 를 말할 때 쓴다).
 *
 * dashboardFallback.CONGESTION_INGEST_PATHS 는 '위 피크타임 모의 발생' 버튼과 '주차 실측 기반
 * 추정 적재(관리자 수동)' 를 경로로 적는다. 두 버튼은 대시보드에서 걷어냈다(D6 — 모의 발생은
 * 데모용 합성이고, 수동 적재는 읽을 때 계산하는 추정으로 대체돼 이중 집계가 된다). 없는 버튼을
 * 가리키는 문장을 화면에 두지 않으려고 여기서 바꿔 끼운다.
 */
export const DASHBOARD_INGEST_PATHS =
  '이 지표의 실측 원천(congestion_logs)에 행이 쌓이는 경로는 손님 제보 · 사장 좌석 방송 · 관리자 오버라이드입니다. 실측이 없는 날에는 공영주차 실측(경주 ITS)과 관광공사 집중률로 오늘의 추정치를 계산해 ‘추정’ 라벨과 함께 보여 줍니다.';

export function dashboardEmptyNotice(basis: DashboardBasis): CongestionEmptyNotice | null {
  if (basis.kind === 'estimate') return null;
  const notice = congestionEmptyNotice(basis);
  if (!notice || notice.remedy === null) return notice;
  return { ...notice, remedy: DASHBOARD_INGEST_PATHS };
}

/**
 * 추정 대신 과거 실측(또는 빈 화면)을 그리고 있다면 **왜 추정이 아닌지**.
 *
 * 추정이 되는 날이 기본이 되었으므로, 추정이 빠진 화면은 그 이유를 말해야 한다 —
 * 말하지 않으면 '추정 모드가 사라졌다(고장)' 로 읽힌다. 옛 서버(키 없음)면 null.
 */
export function estimateUnavailableNote(res: DashboardTodayWithEstimate | null, basis: DashboardBasis): string | null {
  if (!res || res.failed || res.hasLogs || basis.kind === 'estimate' || basis.kind === 'today') return null;
  if (!('estimated' in res) || res.estimated === undefined) return null;
  if (res.estimated === null) {
    return '오늘의 추정치(주차 실측 + 관광 통계)도 지금은 계산하지 못했습니다 — 주차 원본 조회가 실패했거나 시간이 초과됐습니다. 새로고침하면 다시 시도합니다.';
  }
  if (isRecord(res.estimated) && res.estimated.hasLogs === false) {
    const n = num(res.estimated.sampleCount);
    return `오늘의 추정치(주차 실측 + 관광 통계)는 아직 표본이 모자랍니다${n !== null ? `(${n}개 구간)` : ''} — 공영주차 실측이 10분마다 쌓이면 추정으로 바뀝니다.`;
  }
  return '오늘의 추정치 응답 형식을 해석하지 못해 표시하지 않았습니다.';
}

/** CSV 첫 줄 '기준' 칸. 파일로 나간 숫자는 화면 맥락을 잃으므로 추정 여부를 여기 박는다. */
export function csvBasisCell(basis: DashboardBasis): string {
  if (basis.kind === 'estimate') {
    return `오늘 (KST) — 추정치(현장 관측 아님): ${estimateBasisLine(basis.info, basis.dateKst)}`;
  }
  if (basis.kind === 'fallback') return `${basis.dateKst} (KST) — 오늘 관측 없음`;
  return '오늘 (KST)';
}
