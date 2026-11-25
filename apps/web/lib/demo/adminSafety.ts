// 안전 경보 데모(`/admin/safety?demo=1`) 고정 데이터 — 합성값이다(규칙은 lib/demoFixtures.ts 머리말과 같다).
//
// 관제 대시보드 데모와 맞춘다: 황리단길 카페거리가 오후에 경보 기준(90%)을 넘고, 대릉원·첨성대 일대가
// 뒤를 따른다. 임계값 슬라이더를 움직이면 같은 합성 혼잡도로 경보·주의·정상이 다시 갈린다(서버 호출 없음).

import type { SafetyFacilityItem, SafetyStatusResponse, SafetyZone } from '@/app/admin/safety/page';

interface ZoneSeed {
  zoneId: string;
  zoneLabel: string;
  topFacilityId: string;
  avg: number;
  max: number;
  facilityCount: number;
  next: number;
  observedMinutesAgo: number;
  sourceCounts: Record<string, number>;
}

const ZONE_SEEDS: readonly ZoneSeed[] = [
  {
    zoneId: 'demo-zone-hwangridan',
    zoneLabel: '황리단길 카페거리 일대',
    topFacilityId: 'demo-fac-hwangridan-street',
    avg: 0.86,
    max: 0.94,
    facilityCount: 6,
    next: 0.9,
    observedMinutesAgo: 4,
    sourceCounts: { user_report: 3, merchant_report: 2, admin_override: 1 },
  },
  {
    zoneId: 'demo-zone-daereungwon',
    zoneLabel: '대릉원 정문 일대',
    topFacilityId: 'demo-fac-daereungwon-gate',
    avg: 0.71,
    max: 0.78,
    facilityCount: 3,
    next: 0.8,
    observedMinutesAgo: 9,
    sourceCounts: { user_report: 2, merchant_report: 1 },
  },
  {
    zoneId: 'demo-zone-cheomseongdae',
    zoneLabel: '첨성대 주차장 일대',
    topFacilityId: 'demo-fac-cheomseongdae-parking',
    avg: 0.64,
    max: 0.72,
    facilityCount: 2,
    next: 0.69,
    observedMinutesAgo: 12,
    sourceCounts: { user_report: 1, admin_override: 1 },
  },
  {
    zoneId: 'demo-zone-gyochon',
    zoneLabel: '교촌마을 한옥길 일대',
    topFacilityId: 'demo-fac-gyochon-lane',
    avg: 0.41,
    max: 0.5,
    facilityCount: 3,
    next: 0.52,
    observedMinutesAgo: 7,
    sourceCounts: { user_report: 2, merchant_report: 1 },
  },
  {
    zoneId: 'demo-zone-woljeonggyo',
    zoneLabel: '월정교 보행로 일대',
    topFacilityId: 'demo-fac-woljeonggyo-walk',
    avg: 0.33,
    max: 0.39,
    facilityCount: 2,
    next: 0.4,
    observedMinutesAgo: 16,
    sourceCounts: { user_report: 2 },
  },
  {
    zoneId: 'demo-zone-donggung',
    zoneLabel: '동궁과 월지 입구 일대',
    topFacilityId: 'demo-fac-donggung-entrance',
    avg: 0.29,
    max: 0.35,
    facilityCount: 2,
    next: 0.37,
    observedMinutesAgo: 21,
    sourceCounts: { merchant_report: 1, admin_override: 1 },
  },
];

function levelOf(max: number, alert: number, warn: number): SafetyZone['level'] {
  if (max >= alert) return 'alert';
  if (max >= warn) return 'warn';
  return 'normal';
}

const FACILITY_NAMES: Record<string, { name: string; type: string; zoneIdx: number }> = {
  'demo-fac-hwangridan-street': { name: '황리단길 카페거리', type: 'cafe', zoneIdx: 0 },
  'demo-fac-daereungwon-gate': { name: '대릉원 정문', type: 'attraction', zoneIdx: 1 },
  'demo-fac-cheomseongdae-parking': { name: '첨성대 주차장', type: 'parking', zoneIdx: 2 },
};

/**
 * 안전 경보 현황 합성 응답. 임계값(0~1)을 받아 존·시설의 경보/주의/정상을 다시 가른다 —
 * 기본값(경보 0.9 · 주의 0.7)에서는 경보 1 · 주의 2 · 정상 3.
 */
export function demoSafetyStatus(
  now: number = Date.now(),
  alertThreshold = 0.9,
  warnThreshold = 0.7,
): SafetyStatusResponse {
  const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

  const zones: SafetyZone[] = ZONE_SEEDS.map((z) => ({
    zoneId: z.zoneId,
    zoneLabel: z.zoneLabel,
    topFacilityId: z.topFacilityId,
    avgCongestion: z.avg,
    maxCongestion: z.max,
    facilityCount: z.facilityCount,
    level: levelOf(z.max, alertThreshold, warnThreshold),
    nextHourCongestion: z.next,
    observedAt: iso(z.observedMinutesAgo),
    sourceCounts: z.sourceCounts,
  }));

  const facilities: SafetyFacilityItem[] = Object.entries(FACILITY_NAMES).map(([id, f]) => {
    const seed = ZONE_SEEDS[f.zoneIdx];
    return {
      facilityId: id,
      facilityName: f.name,
      facilityType: f.type,
      congestion: seed.max,
      nextHourCongestion: seed.next,
      timestamp: iso(seed.observedMinutesAgo),
      source: 'user_report',
      evidenceTier: 'field_report',
    };
  });

  const alertFacilities = facilities.filter((f) => f.congestion >= alertThreshold);
  const warnFacilities = facilities.filter(
    (f) => f.congestion >= warnThreshold && f.congestion < alertThreshold,
  );

  return {
    generatedAt: iso(0),
    judgement: 'available',
    sampleEmpty: false,
    thresholds: { alert: alertThreshold, warn: warnThreshold },
    meta: { zoneMethod: 'grid_150m', maxObservationAgeMinutes: 30 },
    observedFacilities: ZONE_SEEDS.reduce((n, z) => n + z.facilityCount, 0),
    staleFacilities: 0,
    latestObservedAt: iso(Math.min(...ZONE_SEEDS.map((z) => z.observedMinutesAgo))),
    facilityAlerts: alertFacilities,
    facilityWarnings: warnFacilities,
    zones,
    summary: {
      alertZones: zones.filter((z) => z.level === 'alert').length,
      warnZones: zones.filter((z) => z.level === 'warn').length,
      normalZones: zones.filter((z) => z.level === 'normal').length,
      alertFacilities: alertFacilities.length,
      warnFacilities: warnFacilities.length,
      observedZones: zones.length,
    },
  };
}
