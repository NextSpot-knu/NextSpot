// 수요 압력 — 두 항의 곱, '모름' 과 0 의 구분, 근거 문구.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  demandPressure,
  demandPressureBasis,
  parseCategoryShares,
  toCategoryCode,
} from './demandPressure';

const WEB = process.cwd();

const SHARES = { sampleSize: 26, totalUsers: 683, shares: { restaurant: 0.73, cafe: 0.19, attraction: 0.27, culture: 0.15 } };

// --- 정상 계산 ---------------------------------------------------------------
{
  const p = demandPressure(0.62, 'restaurant', { ...SHARES, shares: { ...SHARES.shares, restaurant: 0.34 } });
  assert.equal(p.status, 'ok');
  if (p.status !== 'ok') throw new Error('unreachable');
  assert.ok(Math.abs(p.value - 0.2108) < 1e-9, '값은 두 항의 곱이다');
  // '현재 상태'(=관측 혼잡)와 **다른 숫자**여야 카드가 자리를 지킬 이유가 생긴다.
  assert.notEqual(Math.round(p.value * 100), Math.round(p.congestion * 100));
  assert.equal(demandPressureBasis(p), '관측 혼잡 62% × 이 업종 선호 34% (온보딩 응답 26명 / 전체 683명)');
}

// --- 관측이 없으면 그리지 않는다 -----------------------------------------------
// null 을 0 으로 바꿔 계산하면 '수요 압력 0%' 라는, 아무도 관측하지 않은 사실이 만들어진다.
assert.deepEqual(demandPressure(null, 'cafe', SHARES), { status: 'hidden', reason: 'no_observation' });

// --- 선호 표본이 없으면 그리지 않는다 -------------------------------------------
assert.deepEqual(
  demandPressure(0.62, 'cafe', { sampleSize: 0, totalUsers: 683, shares: {} }),
  { status: 'hidden', reason: 'no_sample' },
  '표본 0명의 0% 는 관측이 아니다',
);
assert.deepEqual(
  demandPressure(0.62, 'cafe', null),
  { status: 'hidden', reason: 'no_sample' },
  '조회 실패도 그리지 않는다',
);
assert.deepEqual(
  demandPressure(0.62, 'culture', { sampleSize: 26, totalUsers: 683, shares: { cafe: 0.19 } }),
  { status: 'hidden', reason: 'no_sample' },
  '그 업종 항목 자체가 없으면 0 으로 채우지 않는다',
);

// --- 표본이 있는데 아무도 안 고른 업종은 실측 0 이다 -----------------------------
{
  const p = demandPressure(0.62, 'culture', { sampleSize: 26, totalUsers: 683, shares: { culture: 0 } });
  assert.equal(p.status, 'ok', '표본이 있으면 0% 도 관측 결과다');
  if (p.status !== 'ok') throw new Error('unreachable');
  assert.equal(p.value, 0);
}

// --- 업종을 모르면 그리지 않는다 -------------------------------------------------
assert.deepEqual(demandPressure(0.62, null, SHARES), { status: 'hidden', reason: 'unknown_category' });
assert.equal(toCategoryCode('cafe'), 'cafe');
assert.equal(toCategoryCode('bar'), null, '모르는 업종을 관광지로 떠넘기지 않는다');
assert.equal(toCategoryCode(undefined), null);

// --- 응답 파싱 ---------------------------------------------------------------
// 관리자 API 클라이언트(lib/admin-api.ts)는 케이스 변환을 하지 않는다 — 서버 원문(snake_case)을 읽는다.
{
  const parsed = parseCategoryShares({ sample_size: 2, total_users: 5, shares: { cafe: 0.5, bogus: 'x' } });
  assert.deepEqual(parsed, { sampleSize: 2, totalUsers: 5, shares: { cafe: 0.5 } });
}
// 형식이 어긋나면 null — '표본 0' 이 아니다(둘을 섞으면 실패가 데이터 부족으로 읽힌다).
for (const bad of [undefined, null, 'x', 42, [], { sample_size: 'a', total_users: 1 }, { sample_size: 1 }]) {
  assert.equal(parseCategoryShares(bad), null, `${JSON.stringify(bad)} 는 파싱 실패여야 한다`);
}
assert.equal(
  parseCategoryShares({ sampleSize: 2, totalUsers: 5, shares: {} }),
  null,
  '카멜케이스로 오면 파싱 실패다 — 관리자 클라이언트는 변환을 하지 않으므로 이런 응답은 오지 않는다',
);
assert.deepEqual(
  parseCategoryShares({ sample_size: 0, total_users: 3, shares: {} }),
  { sampleSize: 0, totalUsers: 3, shares: {} },
  '표본 0 응답 자체는 정상 응답이다(카드를 내리는 판단은 demandPressure 가 한다)',
);

// --- 화면 배선 가드 ------------------------------------------------------------
// 계산만 맞고 화면이 예전 값(최신 관측 등급)을 그대로 그리는 사고를 막는다.
{
  const page = readFileSync(join(WEB, 'app/admin/infrastructure/page.tsx'), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.match(page, /demandPressure\(/, '인프라 상세가 수요 압력을 계산하지 않는다');
  assert.match(page, /demandPressureBasis\(/, '수요 압력 카드에 근거 문구가 없다 — 숫자만 남으면 지어낸 값과 같다');
  assert.match(
    page,
    /온보딩 선호 반영/,
    "카드 라벨이 '온보딩 선호 반영' 이 아니다",
  );
}

console.log('demandPressure tests passed');
