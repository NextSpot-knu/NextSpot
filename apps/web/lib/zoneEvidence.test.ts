// 구역 혼잡 근거(S3 · lib/zoneEvidence.ts) — 네 단계 → 네 키, 모르는 값 → null, 평소 대비는 단계를 바꾸지 않는다.
// node:assert 독립 스크립트(scripts/run-web-tests.mjs 가 돌린다). 구역 이름은 가짜 값이다(번들 검사와 무관한 테스트 파일).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  zoneBandGrade,
  zoneBandKey,
  zoneClock,
  zoneEvidenceFromBreakdown,
  zoneEvidenceFromCourseStop,
  zoneEvidenceFromZoneView,
  zoneEvidenceLines,
  zoneLevelGrade,
  zoneUsualKey,
  type ZoneEvidence,
} from './zoneEvidence';
import { nearestCurrentZone, zoneBandAt } from './areaNow';
import { congestionKey } from './congestionScale';

// 0) 같은 구역 관측은 한 단어로 말한다 — 서버가 단계 대신 보내는 수준(단계 중앙값 0.125·0.375·0.625·0.875,
//    zone_evidence._BAND_EDGES)을 칩·지도 핀이 congestionKey 로 옮긴 등급과 구역 줄의 단계가 같아야 한다.
//    (예전: 구역 줄 '보통' 옆에 칩 '혼잡도: 여유' — 같은 관측이 두 단어였다.)
{
  const MIDPOINT = { relaxed: 0.125, normal: 0.375, slightly_busy: 0.625, busy: 0.875 } as const;
  for (const [band, level] of Object.entries(MIDPOINT)) {
    assert.equal(zoneBandKey(band), `congestion.${congestionKey(level)}`, `${band}: 구역 줄과 칩이 다른 단어다`);
    assert.equal(zoneBandGrade(band), congestionKey(level), `${band}: 구역 색과 핀 색이 다르다`);
  }
  assert.equal(zoneBandGrade('모름'), null);

  // 코스 막대 · 대안 줄은 구역 수준을 **구역 단계 경계**로 옮긴다 — 운영자의 '혼잡' 경계(busyAt)가 바뀌어도 정류장 칩
  // (구역 단계)과 같은 단어다. 예전에는 busyAt=0.9 면 'busy' 구역(0.875)이 막대에서 '보통', busyAt=0.6 이면 'slightly_busy'
  // (0.625)가 '혼잡' 이 됐다.
  for (const [band, level] of Object.entries(MIDPOINT)) {
    assert.equal(zoneLevelGrade(level), zoneBandGrade(band), `${band}: 코스 막대와 정류장 칩이 다른 등급이다`);
  }
  assert.notEqual(congestionKey(0.875, 0.9), zoneLevelGrade(0.875), '이 테스트의 전제가 바뀌었다(busyAt 0.9 의 경주 경계)');
  assert.equal(zoneLevelGrade(0.25), 'relaxed');
  assert.equal(zoneLevelGrade(0.75), 'busy');
  assert.equal(zoneLevelGrade(null), null);
  assert.equal(zoneLevelGrade(Number.NaN), null);
}

// 1) 네 단계 → 앱 공통 혼잡 등급 키(한산·여유·보통·혼잡). 모르는 값은 null.
{
  assert.equal(zoneBandKey('relaxed'), 'congestion.quiet');
  assert.equal(zoneBandKey('normal'), 'congestion.relaxed');
  assert.equal(zoneBandKey('slightly_busy'), 'congestion.moderate');
  assert.equal(zoneBandKey('busy'), 'congestion.busy');
  for (const unknown of [null, undefined, '', 'slightlyBusy', 'BUSY', '붐빔', 3, 'toString', '__proto__']) {
    assert.equal(zoneBandKey(unknown), null, `모르는 단계 ${String(unknown)} 를 지어냈다`);
  }
  assert.equal(zoneUsualKey('busier'), 'card.zoneUsual.busier');
  assert.equal(zoneUsualKey('usual'), 'card.zoneUsual.usual');
  assert.equal(zoneUsualKey('quieter'), 'card.zoneUsual.quieter');
  assert.equal(zoneUsualKey('constructor'), null);
  assert.equal(zoneUsualKey(null), null);
}

// 2) 키가 4 로케일 JSON 에 모두 있다(화면이 t() 로 그리는 키). 구역 전용 단계 사전(card.zoneBand)은 없다 —
//    같은 단계에 두 이름이 생기지 않게(DESIGN_PRINCIPLES 7).
{
  const WEB = process.cwd();
  for (const locale of ['ko', 'en', 'ja', 'zh']) {
    const messages = JSON.parse(readFileSync(join(WEB, `lib/i18n/messages/${locale}.json`), 'utf8')) as {
      congestion: Record<string, string>;
      card: { zoneBand?: unknown; zoneUsual: Record<string, string>; zoneSource: string; zoneForecastAt: string; zoneObservedAgo: string };
    };
    assert.equal(messages.card.zoneBand, undefined, `${locale}: card.zoneBand 가 다시 생겼다 — 단계 이름은 congestion.* 하나다`);
    for (const band of ['relaxed', 'normal', 'slightly_busy', 'busy']) {
      const key = zoneBandKey(band)!.split('.').pop()!;
      assert.ok(messages.congestion[key], `${locale}: congestion.${key} 없음`);
    }
    for (const cmp of ['busier', 'usual', 'quieter']) {
      assert.ok(messages.card.zoneUsual[cmp], `${locale}: card.zoneUsual.${cmp} 없음`);
    }
    assert.match(messages.card.zoneSource, /\{zone\}/);
    assert.match(messages.card.zoneForecastAt, /\{time\}/);
    assert.match(messages.card.zoneObservedAgo, /\{min\}/);
  }
}

const NOW = Date.parse('2026-11-01T03:00:00Z'); // 서울 12:00

// 3) 평소 대비는 단계 키를 절대 바꾸지 않는다 — 보조 문장만 달라진다.
{
  const base: ZoneEvidence = {
    zoneName: '테스트 구역',
    band: 'busy',
    arrivalBand: null,
    basis: 'persistence',
    observedAt: '2026-11-01T02:50:00Z',
    forecastTargetAt: null,
    usualComparison: null,
    isCurrent: null,
  };
  const without = zoneEvidenceLines(base, NOW)!;
  for (const cmp of ['busier', 'usual', 'quieter'] as const) {
    const lines = zoneEvidenceLines({ ...base, usualComparison: cmp }, NOW)!;
    assert.equal(lines.band.key, without.band.key, `평소 대비(${cmp})가 단계를 바꿨다`);
    assert.equal(lines.band.key, 'congestion.busy');
    assert.equal(lines.usual?.key, `card.zoneUsual.${cmp}`);
  }
  assert.equal(without.usual, null);
  // 한산한 단계도 '평소보다 붐벼요' 로 바뀌지 않는다.
  const relaxedBusier = zoneEvidenceLines({ ...base, band: 'relaxed', usualComparison: 'busier' }, NOW)!;
  assert.equal(relaxedBusier.band.key, 'congestion.quiet');
}

// 4) 근거 줄: 관측은 'N분 전', 예보는 '{time} 도착 기준', 도착 단계가 지금 단계보다 먼저.
{
  const observed = zoneEvidenceLines({
    zoneName: '가', band: 'normal', arrivalBand: null, basis: 'persistence',
    observedAt: '2026-11-01T02:48:00Z', forecastTargetAt: null, usualComparison: null, isCurrent: null,
  }, NOW)!;
  assert.deepEqual(observed.source, { key: 'card.zoneSource', params: { zone: '가' } });
  assert.deepEqual(observed.basis, { key: 'card.zoneObservedAgo', params: { min: 12 } });

  const forecast = zoneEvidenceLines({
    zoneName: '가', band: 'relaxed', arrivalBand: 'slightly_busy', basis: 'provider_forecast',
    observedAt: '2026-11-01T02:48:00Z', forecastTargetAt: '2026-11-01T04:30:00Z', usualComparison: 'quieter', isCurrent: null,
  }, NOW)!;
  assert.equal(forecast.band.key, 'congestion.moderate', '도착 단계를 먼저 말하지 않는다');
  assert.deepEqual(forecast.basis, { key: 'card.zoneForecastAt', params: { time: '13:30' } });
  assert.equal(zoneClock('nonsense'), null);
  // 미래 관측 시각(시계 오차)은 0분으로.
  const skew = zoneEvidenceLines({
    zoneName: '가', band: 'normal', arrivalBand: null, basis: null,
    observedAt: '2026-11-01T03:05:00Z', forecastTargetAt: null, usualComparison: null, isCurrent: null,
  }, NOW)!;
  assert.deepEqual(skew.basis, { key: 'card.zoneObservedAgo', params: { min: 0 } });
}

// 5) 입력 세 갈래 — 경주 breakdown(구역 키 없음)은 null, 단계를 모르면 null.
{
  assert.equal(zoneEvidenceFromBreakdown({ preference: 0.5, waitTime: 3, areaDemandLevel: 0.4 }), null, '경주 breakdown 에 구역 근거를 지어냈다');
  assert.equal(zoneEvidenceFromBreakdown(null), null);
  assert.equal(zoneEvidenceFromBreakdown({ zoneName: '가', zoneLevelBand: 'loud' }), null);
  assert.equal(zoneEvidenceLines(null, NOW), null);
  const fromBreakdown = zoneEvidenceFromBreakdown({
    zoneId: 'z1', zoneName: '가', zoneLevelBand: 'normal', zoneArrivalLevelBand: 'busy',
    congestionArrivalBasis: 'provider_forecast', zoneObservedAt: '2026-11-01T02:50:00Z',
    zoneForecastTargetAt: '2026-11-01T03:20:00Z', zoneUsualComparison: 'usual',
  })!;
  assert.equal(fromBreakdown.arrivalBand, 'busy');
  assert.equal(zoneEvidenceLines(fromBreakdown, NOW)!.band.key, 'congestion.busy');

  assert.equal(zoneEvidenceFromCourseStop(undefined), null);
  const stop = zoneEvidenceFromCourseStop({ zoneName: '나', arrivalBand: 'relaxed', basis: 'persistence', observedAt: '2026-11-01T02:55:00Z' })!;
  assert.equal(zoneEvidenceLines(stop, NOW)!.band.key, 'congestion.quiet');

  const view = zoneEvidenceFromZoneView({ zoneId: 'z2', zoneName: '다', levelBand: 'slightly_busy', observedAt: '2026-11-01T02:40:00Z', isCurrent: true, usualComparison: null })!;
  const viewLines = zoneEvidenceLines(view, NOW)!;
  assert.equal(viewLines.band.key, 'congestion.moderate');
  assert.deepEqual(viewLines.basis, { key: 'card.zoneObservedAgo', params: { min: 20 } });
  assert.equal(zoneEvidenceFromZoneView({ zoneName: '', levelBand: 'busy' }), null, '이름 없는 구역을 말했다');
}

// 5b) 지금이 아닌(30분이 넘은) 구역 단계는 칩으로 말하지 않는다 — 도착 단계가 있을 때만 말한다.
{
  const staleBreakdown = {
    zoneId: 'z1', zoneName: '가', zoneLevelBand: 'busy', zoneArrivalLevelBand: null,
    congestionArrivalBasis: null, zoneObservedAt: '2026-11-01T01:50:00Z', zoneIsCurrent: false,
  };
  const stale = zoneEvidenceFromBreakdown(staleBreakdown)!;
  assert.equal(stale.isCurrent, false);
  assert.equal(zoneEvidenceLines(stale, NOW), null, '70분 전 관측을 지금 단계(붐빔)로 말했다');
  // 서버가 칸을 주지 않으면(배포 어긋남) 관측 시각으로 판정한다.
  const legacy = zoneEvidenceFromBreakdown({ ...staleBreakdown, zoneIsCurrent: undefined })!;
  assert.equal(legacy.isCurrent, null);
  assert.equal(zoneEvidenceLines(legacy, NOW), null, '서버 칸 없이도 낡은 관측을 지금처럼 말했다');
  assert.equal(
    zoneEvidenceLines({ ...legacy, observedAt: '2026-11-01T02:31:00Z' }, NOW)!.band.key,
    'congestion.busy', '29분 전 관측은 지금이다',
  );
  // 도착 단계(순위가 본 값)가 있으면 지금이 아니어도 그것을 말한다.
  const arrival = zoneEvidenceFromBreakdown({ ...staleBreakdown, zoneArrivalLevelBand: 'normal', congestionArrivalBasis: 'provider_forecast', zoneForecastTargetAt: '2026-11-01T03:20:00Z' })!;
  assert.equal(zoneEvidenceLines(arrival, NOW)!.band.key, 'congestion.relaxed');
  // 지도 시설의 구역 — isCurrent=false 면 단계를 말하지 않는다(같은 화면 오버레이가 회색으로 그리는 구역).
  const staleView = zoneEvidenceFromZoneView({ zoneName: '다', levelBand: 'busy', observedAt: '2026-11-01T02:40:00Z', isCurrent: false })!;
  assert.equal(zoneEvidenceLines(staleView, NOW), null, '지도에서 회색인 구역을 카드에서 붐빔이라고 말했다');
  // 매핑 구역 일부가 빈 시설(서버 zone_partial → zoneIsCurrent=false)도 같다.
  assert.equal(zoneEvidenceLines(zoneEvidenceFromBreakdown({ ...staleBreakdown, zoneObservedAt: '2026-11-01T02:58:00Z', zoneLevelBand: 'relaxed' }), NOW), null);
}

// 6) 대기 보드의 '지금 이 일대'(lib/areaNow) — 가장 가까운 **지금** 구역, 가정 시각은 ±30분 예보만.
{
  const center = { lat: 36.5, lng: 127.5 };
  const zones = [
    { zoneName: '먼 구역', levelBand: 'busy', isCurrent: true, centroid: { lat: 36.55, lng: 127.55 } },
    { zoneName: '가까운 낡은 구역', levelBand: 'relaxed', isCurrent: false, centroid: { lat: 36.5001, lng: 127.5001 } },
    {
      zoneName: '가까운 구역', levelBand: 'normal', isCurrent: true, centroid: { lat: 36.501, lng: 127.501 },
      forecast: [
        { targetAt: '2026-11-01T04:00:00Z', levelBand: 'slightly_busy' },
        { targetAt: '2026-11-01T06:00:00Z', levelBand: 'busy' },
      ],
    },
    { zoneName: '단계 없는 구역', levelBand: null, isCurrent: true, centroid: { lat: 36.5, lng: 127.5 } },
  ];
  const zone = nearestCurrentZone(zones, center)!;
  assert.equal(zone.zoneName, '가까운 구역', '지금이 아닌 구역·단계 없는 구역을 골랐다');
  assert.equal(nearestCurrentZone([], center), null);
  assert.equal(zoneBandAt(zone, Date.parse('2026-11-01T04:20:00Z')), 'slightly_busy');
  assert.equal(zoneBandAt(zone, Date.parse('2026-11-01T04:31:00Z')), null, '30분 밖 예보로 말했다');
  assert.equal(zoneBandAt(zone, Date.parse('2026-11-01T04:30:00Z')), 'slightly_busy', '30분 경계를 포함하지 않는다');
  assert.equal(zoneBandAt(zone, Date.parse('2026-11-01T05:40:00Z')), 'busy');
  assert.equal(zoneBandAt({ ...zone, forecast: undefined }, NOW), null);
}

console.log('zoneEvidence tests passed');
