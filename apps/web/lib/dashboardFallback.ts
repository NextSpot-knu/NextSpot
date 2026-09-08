// 관리자 대시보드 '실시간 관제' 가 **무엇을 보고 있는지** 판정하는 순수 함수 모음(렌더 없음).
//
// 왜 별도 모듈인가: 이 화면의 혼잡 카드(평균 혼잡도·이상 혼잡·히트맵)는 congestion_logs 의
// KST '오늘' 구간만 본다. 그런데 그 표는 손님 제보·사장 좌석 방송·관리자 오버라이드·
// simulate-peak 네 경로로만 채워져서, 오늘 구간이 **통째로 비는 날이 실제로 흔하다**
// (실측 2026-09-08: 최신 행이 19일 전). 그때 화면은 그냥 비어 있었고, 관리자는 '고장' 과
// '데이터 없음' 을 구분할 방법이 없었다.
//
// 이 모듈이 고정하는 세 가지:
//   1) 비어 있으면 **왜** 비었는지 말한다(마지막 관측 시각을 실제로 들고 온다).
//   2) 오늘이 비면 가장 최근 관측이 있는 날로 폴백하되, **그 날짜를 반드시 함께** 들고 다닌다.
//      날짜 없이 그리면 오늘 것으로 읽히고, 그건 값을 지어낸 것과 같은 크기의 거짓말이다.
//   3) 폴백도 없으면 **무엇을 하면 채워지는지**까지 말한다.
//
// 이 저장소의 원칙: 실패와 '해당 없음' 과 '실측 0' 은 서로 다른 사실이므로 절대 같은
// 값(특히 0)이나 같은 문구로 뭉개지 않는다.

/** 하루치 혼잡 집계 — 서버(admin.py _aggregate_congestion_day)가 오늘/폴백에 같은 shape 으로 싣는다.
 *  lib/adminMetricState.ts 의 CongestionSlice 와 구조 호환이라 congestionMetric() 에 그대로 넘긴다. */
export interface CongestionDay {
  /** 조회 실패(네트워크/500/권한). 페이지가 얹는 표식이며 표본 없음과 다른 사실이다. */
  failed?: boolean;
  hasLogs?: boolean;
  avgCongestion?: {
    value: number;
    changePercent: number;
    changePercentOrNull?: number | null;
    prevSampleCount?: number;
  } | null;
  anomalyCount?: number | null;
  heatmap?: unknown[] | null;
  anomalies?: unknown[] | null;
  /** 그 구간의 로그 건수. 0 과 '4건뿐'(둘 다 hasLogs=false)을 구분한다. */
  sampleCount?: number;
  /**
   * 그 구간 로그의 source 별 건수(admin.py `_aggregate_congestion_day`).
   * `undefined` = 이 키를 모르는 **옛 서버** 응답 — '섞이지 않았다' 와 다른 사실이라
   * 그때는 아무 배지도 그리지 않는다(모르는 것을 안다고 말하지 않는다).
   */
  sourceComposition?: Record<string, number> | null;
}

/** GET /api/v1/admin/dashboard/today 응답 + 페이지가 얹는 failed 표식. */
export interface DashboardTodayResponse extends CongestionDay {
  /**
   * congestion_logs 전체의 가장 최근 관측 시각(UTC ISO).
   * `undefined` = 이 키를 모르는 **옛 서버** 응답, `null` = 표에 행이 하나도 없음.
   * 둘은 다른 사실이라 화면 문구도 달라야 한다(배포 시차 구간이 실존한다).
   */
  latestObservedAt?: string | null;
  /** 오늘이 비었을 때 서버가 함께 싣는 '가장 최근 관측이 있는 KST 하루' 의 같은 집계. */
  fallback?: (CongestionDay & { dateKst: string; observedAt?: string | null }) | null;
}

/** 화면이 지금 무엇을 보고 있는가. 각 갈래는 화면에서 서로 다른 모양이어야 한다. */
export type CongestionBasis =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'today' }
  | {
      kind: 'fallback';
      /** 그리고 있는 기준일(KST, 'YYYY-MM-DD'). */
      dateKst: string;
      /** **그 날의** 마지막 관측(UTC ISO). */
      observedAt: string | null;
      /**
       * 표 전체의 마지막 관측(UTC ISO). dateKst 보다 뒤일 수 있다 — 서버는 '가장 최근 관측이
       * 있는 날' 이 아니라 '집계할 수 있는(표본 5건 이상) 가장 최근 날' 을 고르기 때문이다.
       * 실측이 정확히 그렇다: 최신 관측 1건은 8/21, 집계 가능한 날은 7/09.
       */
      latestObservedAt: string | null;
    }
  | {
      kind: 'none';
      /** 마지막 관측 시각(UTC ISO). 모르면 null. */
      latestObservedAt: string | null;
      /** 서버가 마지막 관측 시각을 알려주었는가(옛 서버면 false). */
      latestKnown: boolean;
      /** 오늘 구간의 로그 건수. 옛 서버면 null. */
      todaySampleCount: number | null;
    };

export interface CongestionView {
  basis: CongestionBasis;
  /** congestionMetric()/히트맵에 그대로 넘길 하루치 집계. loading 이면 null. */
  day: CongestionDay | null;
}

/**
 * 응답 하나에서 '기준' 과 '그릴 집계' 를 함께 뽑는다.
 *
 * 폴백을 서버 최상위 키에 섞지 않고 별도 객체(fallback)로 받는 이유는 admin.py 쪽에 적어
 * 두었다 — 요약하면 배포 시차 구간의 옛 번들이 과거 데이터를 오늘 것으로 그리는 걸 구조로
 * 막기 위해서다. 그 대신 **폴백을 읽을 줄 아는 이 코드가** 날짜를 항상 함께 들고 다닌다.
 */
export function resolveCongestionView(res: DashboardTodayResponse | null): CongestionView {
  if (res === null) return { basis: { kind: 'loading' }, day: null };
  // 실패 표식은 그대로 실어 보낸다 — congestionMetric() 이 '실패' 와 '표본 없음' 을 갈라야 한다.
  if (res.failed) return { basis: { kind: 'failed' }, day: { failed: true, hasLogs: false } };
  if (res.hasLogs) return { basis: { kind: 'today' }, day: res };

  const fallback = res.fallback;
  if (fallback && fallback.hasLogs && fallback.dateKst) {
    return {
      basis: {
        kind: 'fallback',
        dateKst: fallback.dateKst,
        observedAt: fallback.observedAt ?? null,
        latestObservedAt: res.latestObservedAt ?? null,
      },
      day: fallback,
    };
  }
  return {
    basis: {
      kind: 'none',
      latestObservedAt: res.latestObservedAt ?? null,
      latestKnown: res.latestObservedAt !== undefined,
      todaySampleCount: res.sampleCount ?? null,
    },
    // 폴백이 없으면 그릴 집계도 없다 — '표본 없음' 상태 그대로 넘긴다(0 으로 채우지 않는다).
    day: res,
  };
}

/** UTC ISO → 'YYYY-MM-DD HH:mm (KST)'. 파싱 불가/빈 값은 null(임의 시각을 지어내지 않는다).
 *  브라우저 TZ 에 맡기지 않고 +9h 고정 환산한다 — 이 화면의 하루 경계는 어디서 보든 KST 다. */
export function formatKstDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return null;
  const k = new Date(ms + 9 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())} (KST)`;
}

/** UTC ISO → KST 날짜 'YYYY-MM-DD'. 파싱 불가/빈 값은 null. */
export function kstDate(iso: string | null | undefined): string | null {
  const at = formatKstDateTime(iso);
  return at ? at.slice(0, 10) : null;
}

/** 'YYYY-MM-DD' → 'M/D'. 형식이 다르면 원문 그대로(임의로 잘라 다른 날짜를 만들지 않는다). */
export function shortKstDate(dateKst: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKst);
  if (!m) return dateKst;
  return `${Number(m[2])}/${Number(m[3])}`;
}

/**
 * KPI 타일 제목에 붙일 기간 라벨.
 *
 * 폴백 중에 '오늘' 이라고 적어 두면 그 타일 전체가 거짓이 된다 — 라벨은 기준을 따라간다.
 * loading/failed 는 아직 아무 기준도 없으므로 '오늘'(요청한 기간)을 그대로 쓴다.
 */
export function basisPeriodLabel(basis: CongestionBasis): string {
  return basis.kind === 'fallback' ? shortKstDate(basis.dateKst) : '오늘';
}

/** 기준일 배지 문구. 오늘 기준이면 배지를 내지 않는다(null). */
export function basisDateBadge(basis: CongestionBasis): string | null {
  if (basis.kind !== 'fallback') return null;
  return `${basis.dateKst} (KST) 기준`;
}

/**
 * 폴백 배지 옆에 붙일 설명 — '왜 오늘이 아닌가' 와 '왜 하필 그 날인가' 를 함께 말한다.
 *
 * 두 번째가 중요한 이유: 서버가 고르는 것은 '가장 최근 관측이 있는 날' 이 아니라 '집계할 수
 * 있는(표본 5건 이상) 가장 최근 날' 이다. 실측에서는 8/21 에 관측 1건이 있는데도 기준일이
 * 7/09 로 잡힌다. 그 사이를 설명하지 않으면 화면이 최신 관측을 감춘 것처럼 보인다.
 */
export function fallbackExplanation(basis: CongestionBasis): string | null {
  if (basis.kind !== 'fallback') return null;
  const head = '오늘(KST) 기록된 현장 관측이 없어, 하루 집계를 낼 수 있는 가장 최근 날짜로 물러났습니다.';
  const latestDay = kstDate(basis.latestObservedAt);
  const latestAt = formatKstDateTime(basis.latestObservedAt);
  if (latestDay && latestAt && latestDay > basis.dateKst) {
    return `${head} 그 뒤로도 관측은 있었지만(마지막 ${latestAt}), 하루 평균을 낼 만큼(5건) 쌓인 날이 없어 건너뛰었습니다.`;
  }
  const at = formatKstDateTime(basis.observedAt);
  return at ? `${head} 그 날의 마지막 관측은 ${at} 입니다.` : head;
}

/** congestion_logs 를 채우는 경로 — 화면이 '무엇을 하면 채워지는지' 를 말할 때 쓴다.
 *
 *  ⚠️ 다섯 번째 경로가 생겼다(주차 실측 기반 추정 적재). 그래서 "공영주차 실측은 다른 표에
 *  쌓이므로 이 카드를 채우지 않습니다" 는 더 이상 사실이 아니다 — 문장을 고친다. 대신 그
 *  경로로 들어온 행은 **실측이 아니라 추정**이라는 사실을 함께 적는다. */
export const CONGESTION_INGEST_PATHS =
  "이 지표의 원천(congestion_logs)에 행이 쌓이는 경로는 손님 제보 · 사장 좌석 방송 · 관리자 오버라이드 · 위 '피크타임 모의 발생' · 주차 실측 기반 추정 적재(관리자 수동) 다섯 가지입니다. 마지막 경로로 들어온 값은 시설을 측정한 것이 아니라 주변 공영주차 점유율에서 파생한 추정치입니다.";

/** 실측이 아닌 파생·합성 source 와 그 값이 무엇인지. 화면 라벨의 단일 출처. */
export const ESTIMATED_LOG_SOURCES: Record<string, string> = {
  parking_derived: '주차 실측 기반 추정',
  simulated: '데모 모의 생성',
  seed: '개발 시드',
};

export interface EstimatedBasisNotice {
  /** 이 구간 로그 중 파생·합성 건수. */
  estimatedCount: number;
  /** 전체 건수. */
  totalCount: number;
  /** 전부가 파생·합성인가 — 그렇다면 이 카드에는 실측이 한 건도 없다. */
  entirelyEstimated: boolean;
  /** 배지에 그대로 쓸 문구('주차 실측 기반 추정 1,653건' 형태). */
  badge: string;
  /** 값 옆에 붙일 한 문장. */
  detail: string;
}

/**
 * 이 하루 집계가 **실측인가 추정인가**를 판정한다.
 *
 * 왜 필요한가: 이 카드의 제목은 '시설 혼잡 (손님 제보 · 좌석 방송 기반)' 이다. 주차 파생
 * 추정치가 섞이는 순간 그 제목이 거짓이 된다 — 숫자는 그대로여도 출처가 다르다. 숫자와
 * 출처가 분리되면, 그건 이 저장소가 계속 고쳐 온 '근거 없는 수치 노출' 과 같은 모양이다.
 *
 * `sourceComposition` 이 없으면(옛 서버) `null` — 섞이지 않았다고 단정하지 않는다.
 */
export function estimatedBasisNotice(
  day: CongestionDay | null | undefined,
): EstimatedBasisNotice | null {
  const composition = day?.sourceComposition;
  if (!composition) return null;
  const entries = Object.entries(composition).filter(([, n]) => typeof n === 'number' && n > 0);
  const totalCount = entries.reduce((sum, [, n]) => sum + n, 0);
  const estimated = entries.filter(([source]) => source in ESTIMATED_LOG_SOURCES);
  const estimatedCount = estimated.reduce((sum, [, n]) => sum + n, 0);
  if (!estimatedCount || !totalCount) return null;
  const parts = estimated
    .sort((a, b) => b[1] - a[1])
    .map(([source, n]) => `${ESTIMATED_LOG_SOURCES[source]} ${n.toLocaleString('ko-KR')}건`);
  const entirelyEstimated = estimatedCount === totalCount;
  return {
    estimatedCount,
    totalCount,
    entirelyEstimated,
    badge: parts.join(' · '),
    detail: entirelyEstimated
      ? '이 구간의 값은 전부 추정·모의 데이터입니다. 시설 내부를 측정한 현장 관측은 한 건도 없습니다.'
      : `전체 ${totalCount.toLocaleString('ko-KR')}건 중 ${estimatedCount.toLocaleString('ko-KR')}건이 추정·모의 데이터입니다. 아래 평균과 히트맵은 그 둘을 합쳐 계산한 값입니다.`,
  };
}

export interface CongestionEmptyNotice {
  headline: string;
  detail: string;
  /** 무엇을 하면 채워지는지. 조회 실패일 때는 null(할 일이 다르다). */
  remedy: string | null;
}

/**
 * 비어 있는 이유를 화면 문구로.
 *
 * 예전 문구("히트맵이 비어 있는 것은 데이터가 없다는 뜻이 아닙니다. 새로고침하거나 백엔드
 * 상태를 확인하세요.")는 조회 실패 분기에만 있었는데도 사실과 반대로 읽혔다 — 지금 이
 * 화면이 비는 이유는 정확히 '데이터가 없어서' 이기 때문이다. 두 사실에 각각 다른 문구를
 * 준다.
 */
export function congestionEmptyNotice(basis: CongestionBasis): CongestionEmptyNotice | null {
  if (basis.kind === 'failed') {
    return {
      headline: '혼잡 집계를 불러오지 못했습니다',
      detail:
        '조회 자체가 실패했습니다(네트워크·서버 오류). 아래가 비어 있는 것은 그 때문이며, 오늘 관측이 있었는지 없었는지는 이 화면으로 알 수 없습니다.',
      remedy: null,
    };
  }
  if (basis.kind !== 'none') return null;

  const at = formatKstDateTime(basis.latestObservedAt);
  if (at) {
    return {
      headline: '오늘(KST) 기록된 현장 관측이 없습니다',
      detail: `마지막 관측은 ${at} 입니다. 그 날 이후로 새 기록이 들어오지 않았습니다.`,
      remedy: CONGESTION_INGEST_PATHS,
    };
  }
  if (basis.latestKnown) {
    return {
      headline: '현장 관측 기록이 아직 한 건도 없습니다',
      detail: '오늘뿐 아니라 전체 기간에 걸쳐 기록이 없습니다. 조회는 정상이며, 집계할 표본이 없는 상태입니다.',
      remedy: CONGESTION_INGEST_PATHS,
    };
  }
  // 옛 서버 응답(신규 키 없음) — 모르는 것을 아는 척하지 않는다.
  return {
    headline: '오늘(KST) 기록된 현장 관측이 없습니다',
    detail:
      '마지막 관측이 언제였는지는 지금 연결된 API 버전이 알려주지 않습니다(배포 반영 대기). 그래서 이 화면은 오늘 구간이 비었다는 사실까지만 말할 수 있습니다.',
    remedy: CONGESTION_INGEST_PATHS,
  };
}
