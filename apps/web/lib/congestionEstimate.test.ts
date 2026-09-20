// 추정 모드(주차 실측 + 관광 통계)의 화면 계약 — 추정이 실측처럼 팔리지 않는가.
//
// 지키는 것 넷:
//   1) 모양·신선도 가드 — 구 서버(필드 없음)·오염 값·60분 넘게 낡은 캐시는 '추정 없음' 이다.
//   2) 우선순위 — 실측·예측 숫자가 있으면 추정은 화면에 나오지 않는다.
//   3) 클라 미러(scoreFacility)는 추정을 모른다 — 추정이 붙어도 degraded_rules 그대로다.
//   4) 지도 — 추정 마커는 실측 마커와 **모양이 다르고**, 히트맵·저장·음성 후보에는 추정이 없다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ESTIMATE_MAX_AGE_MS,
  displayableEstimate,
  estimateRadiusKm,
  estimatesFromFeed,
  formatEstimateTime,
  parseCongestionEstimate,
} from './congestionEstimate';
import { getMarkerSvg } from './map/markerSvg';
import { rankFacilities, scoreFacility } from './recommender';

const WEB = process.cwd();
const NOW = new Date('2026-09-20T05:30:00Z'); // 14:30 KST
const raw = {
  level: 0.44,
  source: 'estimated',
  observedAt: '2026-09-20T05:23:00+00:00',
  parkingLevel: 0.31,
  tourismLevel: 0.75,
  lotCount: 3,
  nearestLotM: 220,
  radiusM: 2000,
};

// --- 1) 모양·신선도 ------------------------------------------------------------
{
  const e = parseCongestionEstimate(raw, NOW);
  assert.ok(e, '정상 추정이 걸러졌다');
  assert.equal(e.level, 0.44);
  assert.equal(e.source, 'estimated');
  assert.equal(e.lotCount, 3);
  assert.equal(e.radiusM, 2000);

  assert.equal(parseCongestionEstimate(undefined, NOW), null, '구 서버(필드 없음)는 추정 없음');
  assert.equal(parseCongestionEstimate(null, NOW), null);
  assert.equal(parseCongestionEstimate({ ...raw, source: 'measured' }, NOW), null, 'source 가 estimated 가 아니면 추정으로 믿지 않는다');
  assert.equal(parseCongestionEstimate({ ...raw, level: 1.4 }, NOW), null, '0..1 밖은 버린다');
  assert.equal(parseCongestionEstimate({ ...raw, level: Number.NaN }, NOW), null);
  assert.equal(parseCongestionEstimate({ ...raw, level: '0.4' }, NOW), null, '문자열 숫자를 추정으로 만들지 않는다');
  assert.equal(parseCongestionEstimate({ ...raw, observedAt: null }, NOW), null, '관측 시각이 없으면 "지금" 이라고 말할 수 없다');
  assert.equal(parseCongestionEstimate({ ...raw, observedAt: 'yesterday' }, NOW), null);

  // 24시간 localStorage 캐시·오래 열어 둔 탭: 60분 넘은 추정은 '지금' 이 아니다.
  const stale = new Date(NOW.getTime() - ESTIMATE_MAX_AGE_MS - 60_000).toISOString();
  assert.equal(parseCongestionEstimate({ ...raw, observedAt: stale }, NOW), null, '60분 넘게 낡은 추정이 살아남았다');
  const edge = new Date(NOW.getTime() - ESTIMATE_MAX_AGE_MS + 60_000).toISOString();
  assert.ok(parseCongestionEstimate({ ...raw, observedAt: edge }, NOW), '60분 안쪽은 보여야 한다');
  const farFuture = new Date(NOW.getTime() + 60 * 60_000).toISOString();
  assert.equal(parseCongestionEstimate({ ...raw, observedAt: farFuture }, NOW), null, '한참 미래 시각은 믿지 않는다');

  assert.equal(formatEstimateTime('2026-09-20T05:23:00+00:00'), '14:23', 'KST 로 표기해야 한다(기기 시간대 무관)');
  assert.equal(formatEstimateTime('2026-09-19T18:03:02.078100+00:00'), '03:03');
  assert.equal(formatEstimateTime(null), null);
  assert.equal(estimateRadiusKm(2000), 2);
  assert.equal(estimateRadiusKm(1500), 1.5);
  assert.equal(estimateRadiusKm(undefined), 2);
}

// --- 1-b) 추정 피드 응답 모양 ---------------------------------------------------
{
  const id = 'a2222222-2222-4222-8222-222222222222';
  assert.deepEqual(Object.keys(estimatesFromFeed({ available: true, estimates: { [id]: raw } })), [id]);
  assert.deepEqual(estimatesFromFeed({ available: false, reason: 'parking_snapshot_stale', estimates: { [id]: raw } }), {},
    'available=false 인데 추정을 썼다');
  assert.deepEqual(estimatesFromFeed([]), {}, 'e2e 스텁의 [] 는 추정 없음');
  assert.deepEqual(estimatesFromFeed(undefined), {});
  assert.deepEqual(estimatesFromFeed({ available: true, estimates: [] }), {});
  // 피드는 원본을 그대로 넘긴다 — 60분 만료는 그릴 때의 시각으로 다시 판정해야 한다.
  const stale = { ...raw, observedAt: new Date(NOW.getTime() - 2 * ESTIMATE_MAX_AGE_MS).toISOString() };
  const fed = estimatesFromFeed({ available: true, estimates: { [id]: stale } });
  assert.equal(parseCongestionEstimate(fed[id], NOW), null, '피드로 받은 낡은 추정이 그릴 때 걸러지지 않았다');
}

// --- 2) 우선순위: 측정 > 예측 > 추정 -------------------------------------------
{
  assert.ok(displayableEstimate({ congestionLevel: null, congestionSource: 'none', congestionEstimate: raw }, NOW));
  assert.ok(displayableEstimate({ congestionLevel: null, congestionEstimate: raw }, NOW), '지도 시설(출처 필드 없음)도 추정을 보인다');
  assert.equal(
    displayableEstimate({ congestionLevel: 0.3, congestionSource: 'measured', congestionEstimate: raw }, NOW),
    null,
    '실측이 있는데 추정이 함께 나왔다',
  );
  assert.equal(
    displayableEstimate({ congestionLevel: 0.6, congestionSource: 'predicted', congestionEstimate: raw }, NOW),
    null,
    '예측이 있는데 추정이 함께 나왔다',
  );
  // mockHour(시간 모킹)가 congestionLevel 을 채운 경우 — 숫자가 있으면 추정은 숨는다.
  assert.equal(displayableEstimate({ congestionLevel: 0.8, congestionEstimate: raw }, NOW), null);
}

// --- 3) 클라 미러는 추정을 모른다 ----------------------------------------------
{
  const facility = {
    name: '추정만 있는 카페',
    type: 'cafe',
    latitude: 35.8347,
    longitude: 129.2105,
    congestionLevel: null,
    congestionEstimate: { ...raw, level: 0.95 },
  };
  const spot = scoreFacility(facility, { userLocation: { lat: 35.835, lng: 129.211 } });
  assert.equal(spot.scoringMode, 'degraded_rules', '추정이 클라 미러에서 실측 등급을 얻었다');
  assert.equal(spot.rankingCongestion, null, '추정이 순위 혼잡도로 새어 들어갔다');
  assert.equal(spot.expectedWait, 0, '추정으로 대기 분을 만들었다');

  // 추정이 붙은 시설과 아무것도 없는 시설은 미러 정렬에서 완전히 같은 취급이다(이름순 동률 해소만 다르다).
  const bare = { ...facility, name: '근거 없는 카페', congestionEstimate: undefined };
  const ranked = rankFacilities([facility, bare], { userLocation: { lat: 35.835, lng: 129.211 } });
  assert.equal(ranked[0].spot.score, ranked[1].spot.score, '추정이 미러 점수를 바꿨다');
}

// --- 4) 마커는 추정을 그리지 않는다 --------------------------------------------
// 지도 핀은 **실측 혼잡만** 칠한다(사용자 결정 2026-09-20 — 근거 등급마다 핀 모양을 늘리지 않는다).
// 추정은 시설 상세·추천 카드에서 '추정' 배지로만 말한다.
{
  const decode = (uri: string) => decodeURIComponent(uri.replace(/^data:image\/svg\+xml;charset=utf-8,/, ''));
  const measured = decode(getMarkerSvg('cafe', 0.44, null, false, 0.75));
  const none = decode(getMarkerSvg('cafe', null, null, false, 0.75));

  assert.doesNotMatch(measured, /stroke-dasharray/, '실측 마커가 점선으로 바뀌었다');
  assert.match(none, /#4b5563/, '근거 없음은 종전처럼 회색이어야 한다');
  assert.notEqual(measured, none, '실측과 근거 없음이 같은 마커다');
}

// --- 5) 배선: 추정이 관측 필드로 새지 않는가 ------------------------------------
{
  const strip = (src: string) => src.replace(/^\s*\/\/.*$/gm, '');
  const main = strip(readFileSync(join(WEB, 'app/main/page.tsx'), 'utf8'));
  assert.doesNotMatch(main, /congestionLevel:\s*[^,\n]*[Ee]stimate/, '지도 화면이 추정을 congestionLevel 에 넣는다');
  assert.doesNotMatch(main, /baseCongestion:\s*[^,\n]*[Ee]stimate/, '지도 화면이 추정을 baseCongestion 에 넣는다');
  assert.doesNotMatch(main, /currentCount:\s*[^,\n]*[Ee]stimate/, '추정으로 인원을 만든다');
  assert.doesNotMatch(main, /congestion:\s*x\.congestionEstimate/, '음성 후보가 추정을 관측처럼 보낸다');
  // 지도 핀은 실측 전용이다(사용자 결정 2026-09-20 — 마커 디자인은 종전 그대로 둔다).
  assert.doesNotMatch(main, /getMarkerSvg\([^)]*[Ee]stimate/, '마커가 추정으로 다시 칠해진다');

  // 추정은 별도 피드에서 받고, 24시간 시설 캐시(loadFacilities → saveFacilityCache)에는 넣지 않는다.
  assert.match(main, /getCongestionEstimates\(/, '지도가 추정 피드를 받지 않는다');
  assert.match(main, /setInterval\([\s\S]{0,60}?5 \* 60 \* 1000\)/, '추정 피드를 5분마다 다시 받지 않는다(만료 재판정 없음)');
  const loadStart = main.indexOf('async function loadFacilities()');
  const loadEnd = main.indexOf('loadFacilities();', loadStart);
  assert.ok(loadStart > 0 && loadEnd > loadStart, 'loadFacilities 블록을 찾지 못했다');
  assert.doesNotMatch(main.slice(loadStart, loadEnd), /[Ee]stimate/, '시설 로드(→ 24시간 캐시)에 추정이 섞였다');

  // 히트맵은 실측 전용 — 히트맵 블록에 추정이 등장하면 안 된다.
  const heatStart = main.indexOf('heatmapOverlaysRef.current.forEach((o) => o.setMap(null));');
  const heatBlock = main.slice(heatStart, heatStart + 2500);
  assert.ok(heatStart > 0, '히트맵 블록을 찾지 못했다(구조가 바뀌었다면 이 테스트도 고칠 것)');
  assert.doesNotMatch(heatBlock, /[Ee]stimate/, '히트맵에 추정이 섞였다');

  // 카드들은 대기 분을 추정으로 만들지 않는다 — 추정 배지 문구 키만 쓴다.
  for (const file of ['components/RecommendationCard.tsx', 'app/explore/recommend/page.tsx', 'app/course/page.tsx']) {
    const src = strip(readFileSync(join(WEB, file), 'utf8'));
    assert.match(src, /card\.evidenceEstimated/, `${file} 이 추정 근거(관측 시각·반경)를 밝히지 않는다`);
    assert.doesNotMatch(src, /[Ee]st(imate)?\.level\s*\*\s*avg|estimate[^;\n]*expectedWait/, `${file} 이 추정으로 대기를 만든다`);
  }
}

console.log('congestionEstimate tests passed');
