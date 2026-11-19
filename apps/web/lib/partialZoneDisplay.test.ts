// 내부 검증 지역의 '한 구역이 비어 있는' 시설과 지역 밖 혼잡 답(S3).
//
// (1) 여러 구역에 걸친 시설에서 한 구역의 읽힌 값이 없으면 서버(GET /internal/regions/{r}/infrastructures)가
//     congestion.level 과 zone.level_band · usual_comparison 을 비운다(관측 시각 · 구역 이름은 남는다). 예전에는 조용한 쪽
//     구역 하나의 값으로 핀을 '한산' 으로 칠하고 카드가 '실측 한산' 을 말했다. 화면은 단계를 말하지 않고 '마지막 관측
//     {시각}' 만 남긴다 — /main 장소 기록이 그 시설을 '실측이지만 지금이 아님' 으로 적고(congestionSource measured ·
//     congestionIsCurrent false · 수준 없음), 카드의 congestionDisplay 가 lastObserved(수준 없음)로 옮긴다.
// (2) 내부 지역의 방문 결과는 서버가 체감 혼잡을 버리고 crowd_answer 'not_recorded_region' 을 준다 — 'not_recorded_' 로
//     시작하므로 방문 확인 카드가 '이번 답은 저장되지 않았어요' 중립 문장을 단다.
import assert from 'node:assert/strict';
import { congestionDisplay } from './congestionEstimate';
import { isPaintableMeasurement } from './map/markerSvg';
import { partialZoneObservation, zoneEvidenceFromZoneView, zoneEvidenceLines } from './zoneEvidence';
import { isUnrecordedCrowdAnswer } from './recommendationOutcomes';

const NOW = new Date('2026-11-01T05:00:00Z');
const OBSERVED = '2026-11-01T04:20:00Z';

// (1) 카드 — 단계 없이 마지막 관측만.
{
  const display = congestionDisplay(
    { congestionLevel: null, congestionSource: 'measured', congestionIsCurrent: false, congestionTimestamp: OBSERVED },
    NOW,
  );
  assert.equal(display.mode, 'none', '비운 구역 수준으로 등급을 말했다');
  assert.equal(display.level, null);
  assert.deepEqual(display.lastObserved, { level: null, observedAt: OBSERVED }, '마지막 관측 시각이 사라졌다');

  // 핀은 칠하지 않는다(수준이 없다).
  assert.equal(isPaintableMeasurement({ level: null, observedAt: OBSERVED, source: 'seoul_citydata' }, NOW), false);

  // 구역 근거도 단계가 없으면 만들지 않는다 — 구역 칩 · 줄이 단계를 지어내지 않는다.
  const zone = {
    zoneId: 'z1', zoneName: '시험 구역', cluster: 'c', level: null, levelBand: null,
    observedAt: OBSERVED, isCurrent: false, usualComparison: null, forecast: [],
  };
  const ev = zoneEvidenceFromZoneView(zone);
  assert.equal(ev, null, '단계가 빈 구역으로 근거를 만들었다');
  assert.equal(zoneEvidenceLines(ev, NOW.getTime()), null);

  // /main 장소 기록 조각 — 내부 지역(zone 이 있는) 항목에서만, 수준이 없고 관측 시각이 있을 때만.
  const partialItem = {
    id: 'f1',
    zone,
    congestion: { level: null, currentCount: null, timestamp: OBSERVED, source: 'seoul_citydata', isCurrent: false },
  };
  const piece = partialZoneObservation(partialItem);
  assert.deepEqual(piece, { congestionSource: 'measured', congestionLogSource: 'seoul_citydata', congestionIsCurrent: false });
  // 그 조각을 실은 기록이 카드에서 '마지막 관측' 이 된다(끝에서 끝까지).
  const record = { congestionLevel: null, congestionTimestamp: OBSERVED, ...piece };
  assert.deepEqual(congestionDisplay(record, NOW).lastObserved, { level: null, observedAt: OBSERVED });
  // 기록 모양이 바뀌지 않아야 하는 경우.
  assert.equal(partialZoneObservation({ id: 'g', congestion: { level: null, timestamp: OBSERVED } }), null, '경주 항목(zone 없음)이 바뀌었다');
  assert.equal(partialZoneObservation({ ...partialItem, congestion: { ...partialItem.congestion, level: 0.375 } }), null, '수준이 있는 항목을 비웠다');
  assert.equal(partialZoneObservation({ ...partialItem, congestion: { ...partialItem.congestion, timestamp: null } }), null, '관측 시각 없이 마지막 관측을 만들었다');
  assert.equal(partialZoneObservation({ ...partialItem, congestion: null }), null);
  assert.equal(partialZoneObservation(null), null);
}

// (2) 지역 밖 혼잡 답 — 중립 문장 대상.
assert.equal(isUnrecordedCrowdAnswer('not_recorded_region'), true, '내부 지역 답 미저장을 저장됨으로 읽었다');
assert.equal(isUnrecordedCrowdAnswer('registered'), false);

console.log('partialZoneDisplay tests passed');
