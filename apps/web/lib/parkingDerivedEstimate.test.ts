// 주차 실측 기반 추정 적재 — 판정과 화면 배선을 잠근다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  describeEstimateFailure,
  describeEstimateResult,
  formatSnapshotAge,
  summarizeEstimatePreview,
} from './parkingDerivedEstimate';

const WEB = process.cwd();

// --- 실패 코드는 '무엇을 하면 되는지' 로 옮긴다 -------------------------------
{
  const migration = describeEstimateFailure('migration_not_applied', 409);
  assert.equal(migration.tone, 'warn', '마이그레이션 미적용은 서버 장애가 아니다');
  assert.match(migration.detail, /20260908120000/, '어떤 마이그레이션인지 말하지 않는다');

  const stale = describeEstimateFailure('parking_snapshot_stale', 503);
  assert.equal(stale.tone, 'error');
  assert.doesNotMatch(stale.title, /_/, '코드가 그대로 화면에 남았다');

  // 중복 확인 실패는 '적재를 멈췄다' 는 사실을 말해야 한다 — 안 넣은 것이 결과다.
  assert.match(describeEstimateFailure('duplicate_check_failed', 503).title, /멈췄|중복/);
}

// --- 모르는 코드를 숨기지 않는다 ---------------------------------------------
// 숨기면 새 실패가 조용히 사라진다(adminGuardrailWarnings 와 같은 원칙).
{
  const unknown = describeEstimateFailure('brand_new_code', 503);
  assert.match(unknown.detail, /brand_new_code/, '모르는 코드의 원문을 보여주지 않는다');
  const noCode = describeEstimateFailure(null, 500);
  assert.match(noCode.detail, /500/, '코드가 없으면 최소한 상태 코드는 보여야 한다');
  assert.equal(describeEstimateFailure(null, null).tone, 'error');
}

// --- 성공 응답 세 가지를 뭉개지 않는다 ----------------------------------------
// 셋 다 200 으로 오지만 서로 다른 사실이다.
{
  const recorded = describeEstimateResult({ status: 'recorded', inserted: 834 });
  assert.match(recorded.title, /834/, '적재 건수를 말하지 않는다');
  assert.match(recorded.detail, /추천|학습/, '추정이 순위·학습에서 빠진다는 사실을 안 밝힌다');

  const already = describeEstimateResult({ status: 'already_recorded', inserted: 0 });
  assert.doesNotMatch(already.title, /적재했/, '넣지 않았는데 적재했다고 말한다');
  assert.match(already.detail, /10분/, '언제 다시 누르면 되는지 말하지 않는다');

  const none = describeEstimateResult({ status: 'no_estimates', inserted: 0 });
  assert.equal(none.tone, 'warn');
  assert.match(none.detail, /값이 없는 곳에 값을 만들지 않/, '왜 0건인지 말하지 않는다');
}

// --- 커버리지 숫자만 말하지 않는다 -------------------------------------------
// "1,653곳 중 834곳" 만 보면 관측이 실제보다 두껍게 들린다. 실시간 잔여를 보고하는 주차장은
// 소수이고 한곳에 몰려 있어, 그 몇 개의 관측을 수백 곳에 펼친 값이기 때문이다.
{
  const lines = summarizeEstimatePreview({
    estimatedFacilities: 834,
    facilityCount: 1653,
    skippedNoParking: 819,
    levelMin: 0.679,
    levelMax: 1.0,
    derivedFrom: { lotCount: 4 },
  });
  const joined = lines.join(' / ');
  assert.match(joined, /834/);
  assert.match(joined, /주차장 4곳/, '근거가 된 주차장 개수를 말하지 않는다 — 커버리지가 부풀어 들린다');
  assert.match(joined, /819/, '제외된 시설을 말하지 않는다');
}

// --- 값의 폭이 좁으면 그 사실을 밝힌다 ----------------------------------------
// 전부 비슷한 숫자면 '구역별 혼잡' 이 아니라 사실상 상수 하나다.
{
  const flat = summarizeEstimatePreview({
    estimatedFacilities: 10, levelMin: 0.92, levelMax: 0.98, derivedFrom: { lotCount: 4 },
  }).join(' ');
  assert.match(flat, /변별력/, '값의 폭이 좁은데 그 사실을 숨긴다');

  const spread = summarizeEstimatePreview({
    estimatedFacilities: 10, levelMin: 0.2, levelMax: 0.9, derivedFrom: { lotCount: 4 },
  }).join(' ');
  assert.doesNotMatch(spread, /변별력/, '폭이 넓은데 변별력이 없다고 말한다');
}

// --- 스냅샷 경과 시간 --------------------------------------------------------
// 30초는 반올림하면 1분이다. '방금' 은 반올림해도 0분인 구간(29초 이하)만 쓴다 —
// 여기서 구현을 바꿔 30초를 '방금' 으로 만들면, 1분 가까이 지난 값을 방금이라 부르게 된다.
assert.equal(formatSnapshotAge(10), '방금');
assert.equal(formatSnapshotAge(30), '1분 전');
assert.equal(formatSnapshotAge(600), '10분 전');
assert.equal(formatSnapshotAge(7200), '2시간 전');
assert.equal(formatSnapshotAge(null), null);
assert.equal(formatSnapshotAge(-5), null, '음수 경과는 값이 아니다');
assert.equal(formatSnapshotAge(Number.NaN), null);

// --- 화면 배선 가드 ----------------------------------------------------------
// 판정만 맞고 화면이 안 쓰면 아무 일도 일어나지 않는다.
{
  const button = readFileSync(join(WEB, 'components/admin/ParkingDerivedEstimateButton.tsx'), 'utf8');
  const stripped = button.replace(/^\s*\/\/.*$/gm, '');
  assert.match(stripped, /describeEstimateFailure/, '버튼이 실패 판정을 쓰지 않는다');
  assert.match(stripped, /describeEstimateResult/, '버튼이 결과 판정을 쓰지 않는다');
  assert.match(stripped, /summarizeEstimatePreview/, '버튼이 미리보기 요약을 쓰지 않는다');
  // 적재 전에 미리보기를 반드시 거친다 — 되돌리기 어려운 쓰기라서.
  assert.match(stripped, /parking-derived\/preview/, '미리보기 없이 바로 적재한다');
  // 추정임을 밝히는 문구가 사라지면 이 화면이 추정을 실측으로 파는 자리가 된다.
  assert.match(stripped, /추정치/, '추정임을 밝히는 문구가 없다');
  assert.match(stripped, /추천 순위와 모델 학습에는 쓰이지 않습니다/, '순위·학습 제외 문구가 없다');

  const page = readFileSync(join(WEB, 'app/admin/dashboard/page.tsx'), 'utf8');
  assert.match(page, /ParkingDerivedEstimateButton/, '대시보드가 이 버튼을 마운트하지 않는다');
}

console.log('parkingDerivedEstimate tests passed');
