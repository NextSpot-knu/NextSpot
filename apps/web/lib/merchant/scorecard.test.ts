// 사장님 콘솔 ② 성적표 타일 판정 테스트(PM 결정 4.18).
//
// 규약은 api.test.ts 와 같다: node:assert 로 스스로 판정하는 독립 스크립트(scripts/run-web-tests.mjs 가 돌린다).
// 잠그는 것: 0 인 타일은 그리지 않는다('0 / 0' 금지) · 맨 앞은 '손님 추천에 노출 N회' · 쿠폰을 한 번도 안 줬으면
// 쿠폰 타일 대신 '첫 타임세일을 열어 보세요' 한 줄 · 도착 확인은 숫자가 있을 때만(지금은 데모만).

import assert from 'node:assert/strict';
import { scorecardTiles, scorecardIsEmpty, FIRST_TIMESALE_PROMPT } from './scorecard';
import type { MerchantStats } from './api';

const base: MerchantStats = {
  facility_id: 'f1',
  since: '',
  window_days: 7,
  coupons_issued: 0,
  coupons_used: 0,
  congestion_reports: 0,
  recommendations_exposed: 0,
  recommendations_accepted: 0,
  visit_confirmations: null,
  visit_confirmations_note: '',
};

// 전부 0 — 타일도 프롬프트도 없다(빈 상태는 화면의 '이렇게 시작해 보세요' 가 맡는다).
{
  const card = scorecardTiles(base);
  assert.equal(scorecardIsEmpty(base), true);
  assert.deepEqual(card.tiles, []);
}

// 라이브 심사 가게 모양: 노출은 많고 쿠폰은 아직 없다 → 노출 타일이 맨 앞, 쿠폰 타일 대신 프롬프트.
{
  const stats = { ...base, recommendations_exposed: 3120, recommendations_accepted: 1, congestion_reports: 0 };
  const card = scorecardTiles(stats);
  assert.equal(scorecardIsEmpty(stats), false);
  assert.deepEqual(card.tiles.map((t) => t.key), ['exposed', 'accepted']);
  assert.equal(card.tiles[0].label, '손님 추천에 노출');
  assert.equal(card.tiles[0].value, '3,120회');
  assert.equal(card.tiles[0].hero, true, '노출 타일은 두 칸을 쓰는 맨 앞 타일이다');
  assert.equal(card.tiles[1].label, '길안내 시작');
  assert.equal(card.tiles[1].value, '1건');
  assert.equal(card.showFirstTimesalePrompt, true);
  assert.match(FIRST_TIMESALE_PROMPT, /^첫 타임세일을 열어 보세요/);
  for (const tile of card.tiles) {
    assert.doesNotMatch(tile.value, /^0|\/ 0$/, `0 타일이 그려진다: ${tile.label} ${tile.value}`);
  }
}

// 쿠폰을 준 가게 — 쿠폰 타일('사용 / 발급')이 나오고 프롬프트는 없다. 0 인 혼잡 제보는 빠진다.
{
  const stats = { ...base, recommendations_exposed: 120, recommendations_accepted: 4, coupons_issued: 3, coupons_used: 1 };
  const card = scorecardTiles(stats);
  assert.deepEqual(card.tiles.map((t) => t.key), ['exposed', 'accepted', 'coupons']);
  const coupons = card.tiles.find((t) => t.key === 'coupons')!;
  assert.equal(coupons.value, '1 / 3');
  assert.equal(coupons.sub, '사용 1 · 발급 3');
  assert.equal(card.showFirstTimesalePrompt, false);
}

// 노출이 0 이어도 다른 숫자가 있으면 그것만 보인다(노출 0 타일을 억지로 세우지 않는다).
{
  const stats = { ...base, congestion_reports: 2 };
  const card = scorecardTiles(stats);
  assert.deepEqual(card.tiles.map((t) => t.key), ['reports']);
  assert.equal(card.tiles[0].value, '2건');
}

// 도착 확인은 숫자(>0)일 때만 — 서버가 null(실계정)이나 0 을 주면 그리지 않는다.
{
  assert.equal(scorecardTiles({ ...base, recommendations_exposed: 5, visit_confirmations: null }).tiles.some((t) => t.key === 'arrivals'), false);
  assert.equal(scorecardTiles({ ...base, recommendations_exposed: 5, visit_confirmations: 0 }).tiles.some((t) => t.key === 'arrivals'), false);
  const demo = scorecardTiles({ ...base, recommendations_exposed: 1042, recommendations_accepted: 237, coupons_issued: 196, coupons_used: 138, congestion_reports: 27, visit_confirmations: 104 });
  assert.deepEqual(demo.tiles.map((t) => t.key), ['exposed', 'accepted', 'coupons', 'reports', 'arrivals']);
  assert.equal(demo.tiles.find((t) => t.key === 'arrivals')!.value, '104건');
}

// 개발자 안내·비율 표기가 돌아오지 않는다('추천 수락 a / b' · localStorage · 2단계).
{
  const card = scorecardTiles({ ...base, recommendations_exposed: 3120, recommendations_accepted: 1 });
  const text = card.tiles.map((t) => `${t.label} ${t.value} ${t.sub ?? ''}`).join(' ');
  assert.doesNotMatch(text, /추천 수락|localStorage|2단계|\d+ \/ 3120/);
}

console.log('scorecard.test.ts OK');
