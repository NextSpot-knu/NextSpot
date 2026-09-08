// 프런트 미러의 근거 등급 정렬 — 백엔드 spot/ranking.py 와 같은 규칙인가.
//
// 이 파일이 지키는 것: SPOT 점수는 모드마다 **다른 시간비용 공식**으로 나온다.
// 근거가 없는 후보(degraded)는 대기 항이 0 이라 언제나 최소 시간비용을 받는다 —
// 정직하게 혼잡을 방송한 가게가 아무것도 모르는 옆 가게에게 지는 구조적 하한이다.
// compareSpot 이 등급을 먼저 보지 않으면 화면에서 그 하한이 그대로 살아난다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CROWDED_EVIDENCE_CUTOFF,
  EVIDENCE_TIER_BY_SCORING_MODE,
  WEAKEST_EVIDENCE_TIER,
  compareSpot,
  evidenceTier,
  rankFacilities,
  rankFacilitiesDegraded,
  recToSpot,
  scoreFacility,
  type ScoringMode,
} from './recommender';
import type { RecommendationResponse } from './api-client';

const WEB = process.cwd();

// --- 등급표 자체 --------------------------------------------------------------
assert.equal(evidenceTier('measured_rules'), 0);
assert.equal(evidenceTier('model'), 0, '모델 예측과 실측은 둘 다 대기 항을 쓰는 같은 비용 축이다');
assert.equal(evidenceTier('area_stats_rules'), 1);
assert.equal(evidenceTier('degraded_rules'), 2);
assert.equal(evidenceTier(undefined), WEAKEST_EVIDENCE_TIER, '모드를 모르면 이기지 못한다');
assert.equal(
  EVIDENCE_TIER_BY_SCORING_MODE.measured_rules < EVIDENCE_TIER_BY_SCORING_MODE.area_stats_rules
    && EVIDENCE_TIER_BY_SCORING_MODE.area_stats_rules < EVIDENCE_TIER_BY_SCORING_MODE.degraded_rules,
  true,
  'measured > area_stats > degraded 순서가 깨졌다',
);

// --- 등급이 점수를 이긴다 -----------------------------------------------------
// 점수만 보면 무근거 후보가 앞선다(대기 0분이라 시간비용이 낮으니까). 그게 정확히 고치려는 것이다.
const honest = { name: '정직한 방송', spot: { score: 71, timeToService: 10, preferencePercent: 80, expectedWait: 5, expectedTravel: 5, scoringMode: 'measured_rules' as const } };
const unknown = { name: '근거 없음', spot: { score: 74, timeToService: 5, preferencePercent: 80, expectedWait: 0, expectedTravel: 5, scoringMode: 'degraded_rules' as const } };
assert.ok(unknown.spot.score > honest.spot.score, '픽스처 전제: 점수만 보면 무근거가 이긴다');
assert.ok(compareSpot(honest, unknown) < 0, '근거 있는 후보가 먼저 와야 한다');
assert.ok(compareSpot(unknown, honest) > 0, '정렬 비교가 대칭이어야 한다');

// 같은 등급 안에서는 종전 그대로 점수순이다(등급이 점수를 대체하는 게 아니다).
const strongLow = { name: '실측 낮은 점수', spot: { ...honest.spot, score: 60 } };
assert.ok(compareSpot(honest, strongLow) < 0, '같은 등급이면 높은 점수가 먼저다');
assert.equal(compareSpot(honest, honest), 0);

// --- 미러 계산이 자기 공식을 등급으로 적는가 ----------------------------------
const opts = { userLocation: { lat: 35.8361, lng: 129.2105 }, preferredCategories: ['cafe'] };
const withLog = scoreFacility({ type: 'cafe', latitude: 35.8361, longitude: 129.2105, congestionLevel: 0.4 }, opts);
const withoutLog = scoreFacility({ type: 'cafe', latitude: 35.8361, longitude: 129.2105, congestionLevel: null }, opts);
assert.equal(withLog.scoringMode, 'measured_rules', '혼잡 값이 있으면 대기 항이 실제로 붙는다');
assert.equal(withoutLog.scoringMode, 'degraded_rules', "congestionLevel ?? 0 은 '모른다' 를 '대기 0분' 으로 바꾼다");
assert.equal(withoutLog.expectedWait, 0, '픽스처 전제: 무근거 후보의 대기는 0분이다');
assert.ok(withoutLog.score > withLog.score, '픽스처 전제: 점수만 보면 무근거가 이긴다');

assert.equal(
  rankFacilitiesDegraded([{ type: 'cafe', latitude: 35.8361, longitude: 129.2105 }], opts)[0].spot.scoringMode,
  'degraded_rules',
  'rankFacilitiesDegraded 는 백엔드 degraded_rules 의 미러다',
);

// 섞어서 정렬해도 근거 있는 쪽이 앞이다 — main 화면이 실제로 이렇게 두 목록을 합친다.
const mixed = [
  ...rankFacilitiesDegraded([{ name: '근거 없는 가까운 카페', type: 'cafe', latitude: 35.8361, longitude: 129.2105 }], opts),
  ...rankFacilities([{ name: '혼잡을 아는 먼 카페', type: 'cafe', latitude: 35.8391, longitude: 129.2145, congestionLevel: 0.4 }], opts),
].sort(compareSpot);
assert.equal(mixed[0].name, '혼잡을 아는 먼 카페', '무근거·근거가 섞인 목록에서 근거 있는 쪽이 앞이다');

// --- 서버 판정을 그대로 싣는가 ------------------------------------------------
// 클라가 다시 추측하면 서버 순위와 로컬 순위가 갈린다.
const rec = {
  spotScore: 0.8,
  distanceM: 300,
  scoringMode: 'area_stats_rules',
  breakdown: { preference: 0.7, travelTime: 5, waitTime: 0 },
} as unknown as RecommendationResponse;
assert.equal(recToSpot(rec).scoringMode, 'area_stats_rules');

// --- 화면 배선 가드 ------------------------------------------------------------
// 판정만 맞고 화면이 옛 정렬로 남는 사고를 막는다(이 저장소의 다른 가드와 같은 이유).
// main 화면은 서버 응답 카드와 로컬 미러 카드를 **한 배열로 합쳐** compareSpot 으로 정렬한다.
{
  const page = readFileSync(join(WEB, 'app/main/page.tsx'), 'utf8');
  assert.match(page, /\.sort\(compareSpot\)/, 'main 화면이 compareSpot 으로 정렬하지 않는다');
}

// --- 이미 붐비는 것이 확인된 후보는 등급 이점을 받지 않는다 (검토 38번 ii안) ---------
//
// 등급이 점수보다 앞서므로, 이 가드가 없으면 '만석' 을 방송한 가게가 무근거 가게 전부를 이긴다.
// 사장님에게는 아무 값이나 방송할 유인이 생기고, 분산이라는 목표에도 어긋난다.
{
  const spot = (mode: ScoringMode, score: number, congestion: number | null) => ({
    name: mode + score,
    spot: {
      score, preferencePercent: 0, expectedWait: 0, expectedTravel: 0, timeToService: 0,
      scoringMode: mode, rankingCongestion: congestion,
    },
  });

  // 붐빔이 확인되면 등급이 무근거와 같아진다.
  assert.equal(
    evidenceTier('measured_rules', 0.95),
    evidenceTier('degraded_rules', null),
    '만석 방송이 여전히 등급 이점을 갖는다',
  );
  // 경계값 포함(백엔드가 >= 로 세는 것과 같게).
  assert.equal(evidenceTier('measured_rules', CROWDED_EVIDENCE_CUTOFF), WEAKEST_EVIDENCE_TIER);
  assert.equal(evidenceTier('measured_rules', 0.899), 0);

  // 모른다는 이유로 강등하지 않는다 — 강등은 '붐빔이 확인됐을 때' 만이다.
  assert.equal(evidenceTier('measured_rules', null), 0);
  assert.equal(evidenceTier('measured_rules', undefined), 0);
  assert.equal(evidenceTier('measured_rules', Number.NaN), 0);

  // 정직한 '여유' 방송은 여전히 무근거를 이긴다(원래 고치려던 왜곡을 되살리지 않는다).
  const calm = spot('measured_rules', 50, 0.15);
  const unknownA = spot('degraded_rules', 60, null);
  assert.ok(compareSpot(calm, unknownA) < 0, "정직한 '여유' 방송이 무근거 후보에 밀린다");

  // 만석은 낮은 점수로 무근거를 이기지 못한다.
  const crowded = spot('measured_rules', 30, 0.95);
  const unknownB = spot('degraded_rules', 55, null);
  assert.ok(compareSpot(crowded, unknownB) > 0, '만석 방송이 낮은 점수로도 무근거 후보를 이긴다');
}

console.log('recommender evidence-tier tests passed');
