// 데모 모드 고정 데이터 — `?demo=1` 로 열리는 읽기 전용 콘솔(사장님/관제)이 쓰는 유일한 데이터 출처.
//
// 왜 이 파일이 있는가: 사장님 콘솔(/merchant)과 관제 대시보드(/admin/dashboard)는 로그인 + 역할
// 판정을 통과해야 보이는 화면이라, 계정이 없는 사람에게는 게이트 문구만 보인다. 서비스 소개가
// 약속하는 두 화면이 통째로 보이지 않는 셈이다. `?demo=1` 은 **로그인도 역할 검사도 없이**
// 같은 컴포넌트를 이 파일의 고정값으로 채워 보여 준다.
//
// 규칙(깨면 안 됨):
//   1. 이 파일의 값은 전부 **합성값**이다. 실측이 아니므로 화면에는 항상 '데모 데이터' 배지가 함께 뜬다.
//   2. 데모 모드는 **백엔드를 부르지 않는다** — 조회도, 쓰기도 없다. 쓰기 버튼은 토스트만 띄운다.
//   3. 숫자는 황리단길 일대의 실제 규모감에 맞춘 '그럴듯한' 값이다. 실측으로 오인될 문구를 쓰지 않는다.

import type {
  HourlyCongestionPoint,
  MerchantStats,
  MerchantTimesale,
  SeatLevel,
} from './merchant/api';

/** URL 쿼리에 데모 플래그가 켜져 있는가. (`?demo=1`) */
export function isDemoParam(value: string | null | undefined): boolean {
  return value === '1' || value === 'true';
}

// =========================================================================
// 사장님 콘솔(/merchant?demo=1)
// =========================================================================

/** 데모 가게 — 실제 상호를 쓰지 않는다(실존 점포를 사칭하지 않기 위해). */
export const DEMO_MERCHANT_FACILITY = {
  id: 'demo-facility',
  name: '황리단길 한옥카페 (데모)',
  type: 'cafe',
  couponRate: 0.15,
};

/** 오늘 요약 4종 — 추천 노출 → 수락 → 쿠폰 사용 → 도착 확인의 깔때기. */
export const DEMO_MERCHANT_TODAY = {
  exposures: 184,
  accepted: 41,
  couponsUsed: 23,
  arrivals: 17,
};

/** ② 성적표(최근 7일) — 오늘 값의 대략 5~6배 규모. */
export const DEMO_MERCHANT_STATS: MerchantStats = {
  facility_id: DEMO_MERCHANT_FACILITY.id,
  since: '',
  window_days: 7,
  coupons_issued: 196,
  coupons_used: 138,
  congestion_reports: 27,
  recommendations_exposed: 1042,
  recommendations_accepted: 237,
  visit_confirmations: 104,
  visit_confirmations_note: '도착 확인은 손님이 쿠폰을 연 시점 기준으로 집계합니다(데모 값).',
};

/** ① 시간대별 예상 혼잡 — 지금부터 6시간. */
export const DEMO_MERCHANT_FORECAST: HourlyCongestionPoint[] = [
  { hoursAhead: 0, hour: 13, congestion: 0.62, anchored: true },
  { hoursAhead: 1, hour: 14, congestion: 0.74, anchored: true },
  { hoursAhead: 2, hour: 15, congestion: 0.86, anchored: true },
  { hoursAhead: 3, hour: 16, congestion: 0.91, anchored: false },
  { hoursAhead: 4, hour: 17, congestion: 0.78, anchored: false },
  { hoursAhead: 5, hour: 18, congestion: 0.55, anchored: false },
  { hoursAhead: 6, hour: 19, congestion: 0.41, anchored: false },
];

/** ③ 현재 진행 중인 타임세일 — 20% 할인, 약 1시간 12분 남음. */
export function demoActiveTimesale(now: number = Date.now()): MerchantTimesale {
  return {
    id: 'demo-timesale',
    facility_id: DEMO_MERCHANT_FACILITY.id,
    rate: 0.2,
    starts_at: new Date(now - 48 * 60_000).toISOString(),
    ends_at: new Date(now + 72 * 60_000).toISOString(),
    canceled_at: null,
    created_at: new Date(now - 48 * 60_000).toISOString(),
  };
}

/** ④ 현재 좌석 방송 — 12분 전 '보통'(아직 추천 반영 중). */
export const DEMO_MERCHANT_SEAT: { level: SeatLevel; minutesAgo: number } = {
  level: 'mid',
  minutesAgo: 12,
};

/** ④-보조 시간대별 좌석 여유(오늘) — 0~100%가 높을수록 자리가 많다. */
export const DEMO_MERCHANT_SEAT_BY_HOUR: { hour: number; available: number }[] = [
  { hour: 10, available: 92 },
  { hour: 11, available: 81 },
  { hour: 12, available: 54 },
  { hour: 13, available: 38 },
  { hour: 14, available: 26 },
  { hour: 15, available: 14 },
  { hour: 16, available: 22 },
  { hour: 17, available: 45 },
  { hour: 18, available: 63 },
  { hour: 19, available: 77 },
];

/** 주간 추이 — 최근 7일 노출/수락/쿠폰 사용. */
export const DEMO_MERCHANT_WEEKLY: {
  day: string;
  exposures: number;
  accepted: number;
  couponsUsed: number;
}[] = [
  { day: '월', exposures: 118, accepted: 24, couponsUsed: 13 },
  { day: '화', exposures: 126, accepted: 27, couponsUsed: 15 },
  { day: '수', exposures: 141, accepted: 31, couponsUsed: 18 },
  { day: '목', exposures: 152, accepted: 34, couponsUsed: 19 },
  { day: '금', exposures: 178, accepted: 42, couponsUsed: 25 },
  { day: '토', exposures: 214, accepted: 52, couponsUsed: 31 },
  { day: '일', exposures: 184, accepted: 41, couponsUsed: 23 },
];

// 브리핑 문구(사장님·관제)는 화면 문구라 이 파일이 아니라 i18n 에 있다
// (demo.merchantBriefingText / demo.adminBriefingText — 4개 로케일).

// =========================================================================
// 관제 대시보드(/admin/dashboard?demo=1)
// =========================================================================

/** 오늘의 관제 KPI 4종. */
export const DEMO_ADMIN_KPI = {
  /** 혼잡 지점 → 대안 장소로 실제 이동을 유도한 건수(오늘). */
  dispersals: 312,
  /** 그로 인해 줄어든 누적 대기 시간(분). */
  savedWaitMinutes: 1240,
  /** 타임세일·좌석 방송에 참여 중인 점포 수. */
  participatingStores: 14,
  /** 대안 추천을 받은 사람 중 실제로 대안 장소로 간 비율. */
  alternativeConversion: 0.384,
};

/** 관제 KPI 의 '시나리오' 하루 총량 — lib/adminPredictedView.ts scenarioKpis() 가 시각 진행률(cumulativeDayShare)을
 *  곱해 하루 동안 결정적으로 올라가는 값을 만든다(2026-09-22 예측 모드). 나머지 총량은 이미 위·아래 상수에 있다:
 *  노출 = DEMO_ADMIN_ALTERNATIVES.offered 합(1,013), 길찾기 = moved 합(384), 방문 확인 = DEMO_ADMIN_KPI.dispersals(312).
 *  여기 두 값만 다른 상수에서 파생되지 않아 따로 선언한다. 이 파일 규칙 1(전부 합성값)이 그대로 적용된다. */
export const DEMO_ADMIN_SCENARIO_DAY = {
  /** 오늘 활성 사용자(DAU) 하루 총량 — dispersals(312)의 약 1.5배 규모. */
  dailyActiveUsers: 468,
  /** 방문 확인(312) 뒤 긍정 평가를 남긴 건수 — 방문의 약 3/4. */
  positiveRatings: 236,
};

/** 핫스팟별 시간대 혼잡 추이(오늘, KST). */
export const DEMO_ADMIN_HOTSPOT_TREND: {
  hour: string;
  황리단길: number;
  대릉원: number;
  첨성대: number;
  교촌마을: number;
}[] = [
  { hour: '09시', 황리단길: 0.21, 대릉원: 0.18, 첨성대: 0.24, 교촌마을: 0.12 },
  { hour: '10시', 황리단길: 0.34, 대릉원: 0.29, 첨성대: 0.38, 교촌마을: 0.16 },
  { hour: '11시', 황리단길: 0.52, 대릉원: 0.44, 첨성대: 0.51, 교촌마을: 0.21 },
  { hour: '12시', 황리단길: 0.68, 대릉원: 0.57, 첨성대: 0.62, 교촌마을: 0.27 },
  { hour: '13시', 황리단길: 0.79, 대릉원: 0.66, 첨성대: 0.71, 교촌마을: 0.33 },
  { hour: '14시', 황리단길: 0.91, 대릉원: 0.78, 첨성대: 0.74, 교촌마을: 0.41 },
  { hour: '15시', 황리단길: 0.94, 대릉원: 0.83, 첨성대: 0.69, 교촌마을: 0.48 },
  { hour: '16시', 황리단길: 0.87, 대릉원: 0.74, 첨성대: 0.61, 교촌마을: 0.52 },
  { hour: '17시', 황리단길: 0.72, 대릉원: 0.63, 첨성대: 0.55, 교촌마을: 0.49 },
  { hour: '18시', 황리단길: 0.58, 대릉원: 0.47, 첨성대: 0.42, 교촌마을: 0.44 },
  { hour: '19시', 황리단길: 0.46, 대릉원: 0.31, 첨성대: 0.28, 교촌마을: 0.36 },
];

export const DEMO_ADMIN_HOTSPOT_KEYS = ['황리단길', '대릉원', '첨성대', '교촌마을'] as const;

/** 대안 전환율 — 혼잡 지점에서 제안한 대안이 얼마나 받아들여졌는가. */
export const DEMO_ADMIN_ALTERNATIVES: {
  from: string;
  to: string;
  offered: number;
  moved: number;
}[] = [
  { from: '황리단길', to: '교촌마을', offered: 412, moved: 168 },
  { from: '대릉원', to: '월정교', offered: 286, moved: 103 },
  { from: '첨성대', to: '동궁과 월지', offered: 197, moved: 74 },
  { from: '불국사', to: '괘릉(원성왕릉)', offered: 118, moved: 39 },
];

/** 30일 분산 효과 추이 — DashboardCharts 의 demo 모드 행 모양 그대로. */
export function demoAdminDistribution(): {
  date: string;
  beforeCongestion: number;
  afterCongestion: number;
  alternativeUsage: number;
}[] {
  const days = 30;
  const rows: { date: string; beforeCongestion: number; afterCongestion: number; alternativeUsage: number }[] = [];
  // 기준일을 오늘로 두되, 곡선 자체는 i 로만 결정되는 고정 수식이다(렌더마다 같다).
  const today = new Date();
  const clamp = (v: number) => Math.round(Math.min(0.98, Math.max(0.02, v)) * 1000) / 1000;
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    const progress = (days - 1 - i) / (days - 1);
    rows.push({
      date: `${d.getMonth() + 1}/${d.getDate()}`,
      beforeCongestion: clamp(0.82 + 0.04 * Math.sin(i * 0.9)),
      afterCongestion: clamp(0.78 - 0.3 * progress + 0.03 * Math.sin(i * 1.3)),
      alternativeUsage: clamp(0.08 + 0.42 * progress + 0.02 * Math.cos(i * 1.1)),
    });
  }
  return rows;
}

/** 히트맵 셀(시설 × 시간대) — DashboardHeatmap 이 받는 모양 그대로. */
export function demoAdminHeatmap(): {
  facility: string;
  facilityType: string;
  hour: number;
  value: number | null;
}[] {
  const rows: { name: string; type: string; peak: number; base: number }[] = [
    { name: '황리단길 카페거리', type: 'cafe', peak: 15, base: 0.58 },
    { name: '황리단길 한옥카페', type: 'cafe', peak: 14, base: 0.5 },
    { name: '봉황대 앞 디저트', type: 'cafe', peak: 16, base: 0.44 },
    { name: '황남동 쌈밥거리', type: 'restaurant', peak: 12, base: 0.62 },
    { name: '첨성대 앞 국수', type: 'restaurant', peak: 13, base: 0.48 },
    { name: '교촌마을 한정식', type: 'restaurant', peak: 18, base: 0.4 },
    { name: '대릉원', type: 'attraction', peak: 15, base: 0.66 },
    { name: '첨성대', type: 'attraction', peak: 14, base: 0.6 },
    { name: '동궁과 월지', type: 'attraction', peak: 19, base: 0.54 },
    { name: '경주국립박물관', type: 'culture', peak: 14, base: 0.42 },
    { name: '교촌마을 공방', type: 'culture', peak: 16, base: 0.33 },
  ];
  const cells: { facility: string; facilityType: string; hour: number; value: number | null }[] = [];
  for (const row of rows) {
    for (let hour = 9; hour <= 21; hour += 1) {
      const distance = Math.abs(hour - row.peak);
      const value = Math.max(0.05, Math.min(0.97, row.base + 0.34 - distance * 0.11));
      cells.push({
        facility: row.name,
        facilityType: row.type,
        hour,
        value: Math.round(value * 100) / 100,
      });
    }
  }
  return cells;
}

/** 이상 혼잡 알림 내역(오늘). */
export function demoAdminAnomalies(now: number = Date.now()): {
  id: string;
  facilityName: string;
  timestamp: string;
  congestionLevel: number;
  durationMinutes: number;
}[] {
  return [
    { id: 'demo-a1', facilityName: '황리단길 카페거리', minutesAgo: 24, congestionLevel: 0.94, durationMinutes: 40 },
    { id: 'demo-a2', facilityName: '대릉원 정문', minutesAgo: 71, congestionLevel: 0.92, durationMinutes: 30 },
    { id: 'demo-a3', facilityName: '첨성대 주차장', minutesAgo: 126, congestionLevel: 0.91, durationMinutes: 20 },
  ].map((a) => ({
    id: a.id,
    facilityName: a.facilityName,
    timestamp: new Date(now - a.minutesAgo * 60_000).toISOString(),
    congestionLevel: a.congestionLevel,
    durationMinutes: a.durationMinutes,
  }));
}

/** 참여 점포 현황 — 무엇을 켜 두었는가. */
export const DEMO_ADMIN_STORES: {
  name: string;
  area: string;
  timesale: string | null;
  seat: '여유' | '보통' | '만석';
}[] = [
  { name: '황리단길 한옥카페', area: '황남동', timesale: '20%', seat: '보통' },
  { name: '봉황대 앞 디저트', area: '황남동', timesale: '15%', seat: '여유' },
  { name: '황남동 쌈밥거리', area: '황남동', timesale: null, seat: '만석' },
  { name: '교촌마을 한정식', area: '교동', timesale: '30%', seat: '여유' },
  { name: '첨성대 앞 국수', area: '인왕동', timesale: null, seat: '보통' },
  { name: '월정교 찻집', area: '교동', timesale: '15%', seat: '여유' },
];
