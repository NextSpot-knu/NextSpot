// 사장님 콘솔 ② 성적표 타일 판정 테스트(PM 결정 4.18, P1-2).
//
// 규약은 api.test.ts 와 같다: node:assert 로 스스로 판정하는 독립 스크립트(scripts/run-web-tests.mjs 가 돌린다).
// 잠그는 것: 0 인 타일은 그리지 않는다('0 / 0' 금지 — 단 직전 기간에 숫자가 있던 0 은 세운다) · 맨 앞은 추천 노출이고
// 이름은 서버가 센 기준(카드/목록)을 따른다 · 쿠폰을 한 번도 안 줬으면 쿠폰 타일 대신 '타임세일을 열어 보세요' 한 줄
// (진행 중인 세일이 없다고 확인됐을 때만) · 도착 확인은 숫자가 있을 때만 · 두 칸 격자에 반 칸짜리 외톨이 타일이 남지 않는다 ·
// 직전 기간 비교·사람 수는 서버가 준 만큼만(지어내지 않는다) · 브리핑 자리 요약은 숫자만 말한다.

import assert from 'node:assert/strict';
import {
  EXPOSURE_LABEL,
  TIMESALE_PROMPT,
  scorecardIsEmpty,
  scorecardNotes,
  scorecardSummary,
  scorecardTiles,
} from './scorecard';
import type { MerchantMetric, MerchantStats } from './api';

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

const m = (current: number | null, previous: number | null = null, people: number | null = null, counted_since: string | null = null): MerchantMetric => ({
  current,
  previous,
  people,
  counted_since,
});

/** 새 API 모양 — 예전 칸과 metrics 를 함께 준다(서버는 둘을 같은 숫자로 채운다). */
function v2(metrics: NonNullable<MerchantStats['metrics']>, extra: Partial<MerchantStats> = {}): MerchantStats {
  return {
    ...base,
    recommendations_exposed: metrics.exposures?.current ?? 0,
    recommendations_accepted: metrics.accepts?.current ?? 0,
    visit_confirmations: metrics.arrivals?.current ?? null,
    coupons_issued: metrics.coupons_issued?.current ?? 0,
    coupons_used: metrics.coupons_used?.current ?? 0,
    congestion_reports: metrics.congestion_reports?.current ?? 0,
    exposure_basis: 'card_shown',
    internal_accounts_excluded: true,
    metrics,
    ...extra,
  };
}

const wideKeys = (stats: MerchantStats) => scorecardTiles(stats).tiles.filter((t) => t.wide).map((t) => t.key);
const tileOf = (stats: MerchantStats, key: string) => scorecardTiles(stats).tiles.find((t) => t.key === key);

// 전부 0 — 타일도 프롬프트도 없다(빈 상태는 화면의 '이렇게 시작해 보세요' 가 맡는다).
{
  const card = scorecardTiles(base, { saleActive: false });
  assert.equal(scorecardIsEmpty(base), true);
  assert.deepEqual(card.tiles, []);
  assert.equal(card.showTimesalePrompt, false);
}

// 라이브 심사 가게 모양(구 API — 기준 칸이 없다): 행 수였으므로 '노출' 이 아니라 '추천 목록에 포함된 횟수' 로 단다.
{
  const stats = { ...base, recommendations_exposed: 3120, recommendations_accepted: 1, congestion_reports: 0 };
  const card = scorecardTiles(stats, { saleActive: false });
  assert.equal(scorecardIsEmpty(stats), false);
  assert.deepEqual(card.tiles.map((t) => t.key), ['exposed', 'accepted']);
  assert.equal(card.tiles[0].label, '추천 목록에 포함된 횟수');
  assert.equal(card.tiles[0].value, '3,120회');
  assert.equal(card.tiles[0].hero, true, '노출 타일은 두 칸을 쓰는 맨 앞 타일이다');
  assert.match(card.tiles[0].sub ?? '', /알 수 없어요/, '목록 기준 숫자는 손님이 봤다는 뜻이 아니라고 말해야 한다');
  assert.equal(card.tiles[1].label, '길안내 시작');
  assert.equal(card.tiles[1].value, '1건');
  // 구 API 는 비교값·사람 수를 주지 않는다 — 지어내지 않는다.
  assert.equal(card.tiles[1].detail, undefined);
  assert.equal(card.showTimesalePrompt, true);
  assert.match(TIMESALE_PROMPT, /^타임세일을 열어 보세요/);
  for (const tile of card.tiles) {
    assert.doesNotMatch(tile.value, /^0|\/ 0$/, `0 타일이 그려진다: ${tile.label} ${tile.value}`);
  }
}

// 카드 기준(rec_shown) — '손님 화면에 뜬 추천 카드'. 이름이 곧 뜻이라 설명 줄을 붙이지 않는다.
{
  const card = scorecardTiles({ ...base, exposure_basis: 'card_shown', recommendations_exposed: 128 });
  assert.equal(card.tiles[0].label, EXPOSURE_LABEL.card_shown);
  assert.equal(card.tiles[0].label, '손님 화면에 뜬 추천 카드');
  assert.equal(card.tiles[0].value, '128회');
  assert.equal(card.tiles[0].sub, undefined);
  // 두 기준의 이름이 같으면 사장님은 3,120회 → 128회 를 '손님이 줄었다' 로 읽는다.
  assert.notEqual(EXPOSURE_LABEL.card_shown, EXPOSURE_LABEL.list_rows);
}

// 리뷰(10-07) — 심사위원이 ③ 에서 세일을 열면 쿠폰은 아직 0 이다(손님이 추천을 받아들여야 발급된다).
// 그때 '타임세일을 열어 보세요' 가 '⚡ 20% 타임세일 진행 중' 배너 옆에 남으면 안 된다.
{
  const stats = { ...base, recommendations_exposed: 3120, recommendations_accepted: 1 };
  assert.equal(scorecardTiles(stats, { saleActive: true }).showTimesalePrompt, false, '진행 중인 세일 옆에서 세일을 열라고 한다');
  // 세일 여부를 아직 모르면(③ 이 불러오는 중이거나 실패) 감춘다 — 보였다가 사라지는 줄을 만들지 않는다.
  assert.equal(scorecardTiles(stats, { saleActive: null }).showTimesalePrompt, false);
  assert.equal(scorecardTiles(stats).showTimesalePrompt, false);
  // 지난 세일 이력은 이 화면이 모른다 — '첫' 은 예전에 세일을 열었던 가게에 사실이 아니다.
  assert.doesNotMatch(TIMESALE_PROMPT, /첫/);
}

// 쿠폰을 준 가게 — 쿠폰 타일('사용 / 발급')이 나오고 프롬프트는 없다. 0 인 혼잡 제보는 빠진다.
{
  const stats = { ...base, recommendations_exposed: 120, recommendations_accepted: 4, coupons_issued: 3, coupons_used: 1 };
  const card = scorecardTiles(stats, { saleActive: false });
  assert.deepEqual(card.tiles.map((t) => t.key), ['exposed', 'accepted', 'coupons']);
  const coupons = card.tiles.find((t) => t.key === 'coupons')!;
  assert.equal(coupons.value, '1 / 3');
  assert.equal(coupons.sub, '사용 1 · 발급 3');
  assert.equal(card.showTimesalePrompt, false);
}

// 노출이 0 이어도 다른 숫자가 있으면 그것만 보인다(노출 0 타일을 억지로 세우지 않는다).
{
  const stats = { ...base, congestion_reports: 2 };
  const card = scorecardTiles(stats);
  assert.deepEqual(card.tiles.map((t) => t.key), ['reports']);
  assert.equal(card.tiles[0].value, '2건');
}

// 두 칸 격자 — 맨 앞(노출) 타일 뒤가 홀수 개면 마지막 타일이 두 칸을 쓴다(반 칸 옆 빈칸 금지).
{
  // 라이브 심사 가게: 노출 + 길안내 → 길안내가 혼자 반 칸이던 모양.
  assert.deepEqual(wideKeys({ ...base, recommendations_exposed: 3120, recommendations_accepted: 1 }), ['accepted']);
  // 노출 + 둘 → 두 타일이 한 줄을 나눠 쓴다.
  assert.deepEqual(wideKeys({ ...base, recommendations_exposed: 120, recommendations_accepted: 4, congestion_reports: 1 }), []);
  // 노출 + 셋 → 마지막(혼잡 제보)만 두 칸.
  assert.deepEqual(
    wideKeys({ ...base, recommendations_exposed: 120, recommendations_accepted: 4, coupons_issued: 3, coupons_used: 1, congestion_reports: 1 }),
    ['reports'],
  );
  // 노출이 없고 하나뿐 → 그 하나가 두 칸.
  assert.deepEqual(wideKeys({ ...base, congestion_reports: 2 }), ['reports']);
  // 노출만 → 맨 앞 타일은 이미 두 칸(wide 를 따로 달지 않는다).
  assert.deepEqual(wideKeys({ ...base, recommendations_exposed: 5 }), []);
  // 맨 앞 타일에는 wide 를 달지 않는다(숫자 크기는 hero 가 정한다).
  assert.equal(scorecardTiles({ ...base, recommendations_exposed: 5 }).tiles[0].wide, undefined);
}

// 도착 확인은 숫자(>0)일 때만 — 서버가 null(못 읽음·구 API)이나 0 을 주면 그리지 않는다.
// 순서는 손님이 지나는 길 그대로: 노출 → 길안내 → 도착 → 쿠폰 → 제보.
{
  assert.equal(scorecardTiles({ ...base, recommendations_exposed: 5, visit_confirmations: null }).tiles.some((t) => t.key === 'arrivals'), false);
  assert.equal(scorecardTiles({ ...base, recommendations_exposed: 5, visit_confirmations: 0 }).tiles.some((t) => t.key === 'arrivals'), false);
  const demo = scorecardTiles({ ...base, recommendations_exposed: 1042, recommendations_accepted: 237, coupons_issued: 196, coupons_used: 138, congestion_reports: 27, visit_confirmations: 104 });
  assert.deepEqual(demo.tiles.map((t) => t.key), ['exposed', 'accepted', 'arrivals', 'coupons', 'reports']);
  assert.equal(demo.tiles.find((t) => t.key === 'arrivals')!.value, '104건');
  // 데모 모양(노출 + 넷)은 두 줄을 꽉 채운다.
  assert.deepEqual(demo.tiles.filter((t) => t.wide).map((t) => t.key), []);
}

// 개발자 안내·비율 표기가 돌아오지 않는다('추천 수락 a / b' · localStorage · 2단계).
{
  const card = scorecardTiles({ ...base, recommendations_exposed: 3120, recommendations_accepted: 1 });
  const text = card.tiles.map((t) => `${t.label} ${t.value} ${t.sub ?? ''} ${t.detail ?? ''}`).join(' ');
  assert.doesNotMatch(text, /추천 수락|localStorage|2단계|\d+ \/ 3120/);
}

// ── P1-2: 직전 기간 비교 · 사람 수(표본) · 일부 기간 집계 ─────────────────────────

// 비교는 건수 차이로 — 사람 수가 먼저, 그다음 '직전 N일 값(차이)'.
{
  const stats = v2({
    exposures: m(128, 97, 41),
    accepts: m(5, 3, 4),
    arrivals: m(3, 3, 3),
  });
  assert.equal(tileOf(stats, 'exposed')!.detail, '41명 · 직전 7일 97회(+31)');
  assert.equal(tileOf(stats, 'accepted')!.detail, '4명 · 직전 7일 3건(+2)');
  assert.equal(tileOf(stats, 'arrivals')!.detail, '3명 · 직전 7일 3건(같음)');
  // 비율(%)로 말하지 않는다 — 작은 가게일수록 비율이 숫자를 부풀린다.
  for (const tile of scorecardTiles(stats).tiles) assert.doesNotMatch(tile.detail ?? '', /%/);
}

// 30일 보기 — 비교 기간의 이름도 30일이다.
{
  const stats = v2({ accepts: m(12, 20, 9) }, { window_days: 30 });
  assert.equal(tileOf(stats, 'accepted')!.detail, '9명 · 직전 30일 20건(−8)');
}

// 이번엔 0 이어도 직전 기간에 있었으면 세운다(줄어든 사실을 숨기지 않는다). 직전도 0 이면 세우지 않는다.
{
  const dropped = v2({ exposures: m(40, 38, 12), arrivals: m(0, 3, 0) });
  const arrivals = tileOf(dropped, 'arrivals');
  assert.ok(arrivals, '직전 7일 3건이던 도착 확인이 0건이 되자 타일이 사라졌다');
  assert.equal(arrivals!.value, '0건');
  assert.equal(arrivals!.detail, '직전 7일 3건(−3)', '0명은 말하지 않는다');
  assert.equal(tileOf(v2({ exposures: m(40, 38), arrivals: m(0, 0) }), 'arrivals'), undefined);
  // 이번 기간이 전부 0 이어도 직전 기간에 숫자가 있었으면 빈 상태('이렇게 시작해 보세요')가 아니다.
  assert.equal(scorecardIsEmpty(v2({ exposures: m(0, 5), accepts: m(0, 0) })), false);
}

// 비교할 수 없으면(previous=null — 그 기간에는 기록이 없었다) 비교를 지어내지 않고, 언제부터 센 숫자인지 말한다.
{
  const stats = v2({ exposures: m(57, null, 20, '2026-10-23T20:00:00+00:00') }, { window_days: 30 });
  const detail = tileOf(stats, 'exposed')!.detail ?? '';
  assert.equal(detail, '20명 · 10월 24일부터 집계', '집계 시작일은 한국 날짜다(UTC 10-23 20시 = KST 10-24)');
  assert.doesNotMatch(detail, /직전/);
}

// 쿠폰 타일은 직전 기간의 사용·발급을 함께 보여 준다(비교값이 있을 때만).
{
  const stats = v2({ exposures: m(10, 8), coupons_issued: m(3, 2), coupons_used: m(1, 2) });
  assert.equal(tileOf(stats, 'coupons')!.detail, '직전 7일 사용 2 · 발급 2');
  assert.equal(tileOf({ ...base, recommendations_exposed: 10, coupons_issued: 3, coupons_used: 1 }, 'coupons')!.detail, undefined);
}

// 혼잡 제보는 사람 수를 말하지 않는다(익명 제보가 섞여 사람 수가 정확하지 않다).
{
  const stats = v2({ congestion_reports: m(4, 1, 3) });
  assert.equal(tileOf(stats, 'reports')!.detail, '직전 7일 1건(+3)');
}

// ── 브리핑 자리의 요약(LLM 없이 성적표 숫자로) ─────────────────────────────────────
{
  const full = v2({ exposures: m(128, 97, 41), accepts: m(5, 3, 4), arrivals: m(3, 1, 3) });
  assert.deepEqual(scorecardSummary(full), {
    title: '최근 7일 한눈에',
    text: '최근 7일 동안 우리 가게가 손님 화면에 추천 카드로 128번 떴고, 길안내 시작 5건 · 도착 확인 3건이 있었어요. 도착 확인은 직전 7일(1건)보다 2건 늘었어요.',
  });

  // 길안내가 없으면 '0건이 있었어요' 가 아니라 없다고 말한다. 비교할 숫자가 둘 다 0 이면 비교 문장도 없다.
  const quiet = v2({ exposures: m(40, null, 12), accepts: m(0, 0), arrivals: m(0, 0) });
  assert.equal(
    scorecardSummary(quiet)?.text,
    '최근 7일 동안 우리 가게가 손님 화면에 추천 카드로 40번 떴어요. 길안내를 시작한 손님은 아직 없어요.',
  );

  // 도착이 0 이고 길안내만 있으면 있었던 것만 말하고, 비교는 도착(직전 2건)부터 본다.
  const fewer = v2({ exposures: m(60, 50), accepts: m(2, 2, 2), arrivals: m(0, 2) });
  assert.equal(
    scorecardSummary(fewer)?.text,
    '최근 7일 동안 우리 가게가 손님 화면에 추천 카드로 60번 떴고, 길안내 시작 2건이 있었어요. 도착 확인은 직전 7일(2건)보다 2건 줄었어요.',
  );

  // 도착을 못 읽었으면(null) 길안내로 비교한다.
  const noArrivals = v2({ exposures: m(60, 50), accepts: m(4, 4, 3), arrivals: m(null) });
  assert.match(scorecardSummary(noArrivals)?.text ?? '', /길안내 시작은 직전 7일과 같아요\(4건\)\.$/);

  // 구 API(목록 행 · 비교 없음) — 이름을 바꿔 말하고 비교 문장을 지어내지 않는다.
  const legacy = { ...base, recommendations_exposed: 3120, recommendations_accepted: 1 };
  assert.equal(
    scorecardSummary(legacy)?.text,
    '최근 7일 동안 우리 가게가 추천 목록에 3,120번 들어갔고, 길안내 시작 1건이 있었어요.',
  );

  // 손님 흐름이 하나도 없으면 아무것도 그리지 않는다(빈 카드·제목만 남은 카드 금지).
  assert.equal(scorecardSummary(base), null);
  assert.equal(scorecardSummary({ ...base, coupons_issued: 2, coupons_used: 1, congestion_reports: 3 }), null);

  // 서비스가 스스로를 평가하는 말·권유를 붙이지 않는다.
  for (const stats of [full, quiet, fewer, noArrivals, legacy]) {
    assert.doesNotMatch(scorecardSummary(stats)?.text ?? '', /솔직|투명|확실|믿을|정확|좋아요|축하|해 보세요/);
  }
}

// ── '숫자는 이렇게 셉니다' — 서버가 실제로 그렇게 셌을 때만 그 문장 ──────────────────
{
  const card = scorecardNotes(v2({ exposures: m(57, null, 20, '2026-10-24T03:00:00+00:00') }));
  assert.match(card[0], /추천 순위와 함께 뜬 횟수/);
  assert.match(card[0], /10월 24일부터 쌓였어요/);
  assert.ok(card.some((n) => /같은 날 여러 번 눌러도 한 번/.test(n)));
  assert.ok(card.some((n) => /관리자·개발자 계정/.test(n)));

  // 구 API 는 같은 날 중복을 합치지도, 내부 계정을 빼지도 않았다 — 그 문장을 붙이면 거짓이다.
  const legacy = scorecardNotes({ ...base, recommendations_exposed: 3120 });
  assert.equal(legacy.length, 1);
  assert.match(legacy[0], /실제로 보였는지는 알 수 없어요/);

  // 사람 수의 단위는 지표마다 다르다(리뷰 10-31) — 카드 기준 노출만 기기이고, 길안내·도착은 계정이다.
  // '사람 수는 기기 기준' 한 문장으로 뭉뚱그리면 길안내·도착 사람 수에 대해 틀린 말이 된다.
  const cardPeople = card.find((n) => n.startsWith('사람 수'));
  assert.equal(cardPeople, '사람 수는 추천 카드는 기기 기준, 길안내 시작·도착 확인은 앱 계정(게스트 포함) 기준이에요. 직전 기간 기록이 없으면 비교하지 않아요.');
  // 목록 행 기준(카드 기록을 못 읽음)이면 노출 사람 수도 계정이다 — '기기' 를 말하지 않는다.
  const rows = scorecardNotes(v2({ exposures: m(300, 280, 90) }, { exposure_basis: 'list_rows' }));
  const rowsPeople = rows.find((n) => n.startsWith('사람 수'));
  assert.equal(rowsPeople, '사람 수는 앱 계정(게스트 포함) 기준이에요. 직전 기간 기록이 없으면 비교하지 않아요.');
  assert.doesNotMatch(rowsPeople ?? '', /기기/);
  // 구 API 는 사람 수를 주지 않는다 — 단위 설명도 없다.
  assert.equal(legacy.some((n) => n.startsWith('사람 수')), false);

  for (const note of [...card, ...rows, ...legacy]) assert.doesNotMatch(note, /솔직|투명|확실|믿을/);
}

console.log('scorecard.test.ts OK');
