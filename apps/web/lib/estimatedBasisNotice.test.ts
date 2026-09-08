// 관제 화면이 '실측' 과 '추정' 을 구분해 말하는지 — 주차 실측 파생 추정치(parking_derived)가
// 시설 혼잡 카드에 섞였을 때의 라벨 계약.
//
// 왜 이 가드가 필요한가: 이 카드의 제목은 '시설 혼잡 (손님 제보 · 좌석 방송 기반)' 이다.
// congestion_logs 에는 두 달 동안 실관측이 1건뿐이라, 추정치를 넣는 순간 이 카드의 값은
// **거의 전부** 추정이 된다. 숫자는 그대로여도 출처가 다른데 제목이 그대로면, 그건 이
// 저장소가 계속 고쳐 온 '근거 없는 수치 노출' 과 같은 모양이다.
import { strict as assert } from 'node:assert';
import {
  CONGESTION_INGEST_PATHS,
  ESTIMATED_LOG_SOURCES,
  estimatedBasisNotice,
  type CongestionDay,
} from './dashboardFallback';

const day = (composition: Record<string, number> | null | undefined): CongestionDay => ({
  hasLogs: true,
  sampleCount: Object.values(composition ?? {}).reduce((a, b) => a + b, 0),
  sourceComposition: composition,
});

function main() {
  // ── 파생·합성 출처가 없으면 배지도 없다 ────────────────────────────────────
  assert.equal(
    estimatedBasisNotice(day({ user_report: 12, merchant_report: 3 })),
    null,
    '실측만 있는데 추정 배지를 그린다',
  );

  // ── 옛 서버 응답(구성 정보 없음)에는 아무 말도 하지 않는다 ─────────────────
  // '섞이지 않았다' 와 '모른다' 는 다른 사실이다. 모르는 것을 안다고 말하지 않는다.
  assert.equal(estimatedBasisNotice(day(undefined)), null, '모르는 것을 안다고 말한다');
  assert.equal(estimatedBasisNotice(day(null)), null);
  assert.equal(estimatedBasisNotice(null), null);

  // ── 전부 추정이면 그렇게 말한다 ────────────────────────────────────────────
  {
    const notice = estimatedBasisNotice(day({ parking_derived: 806 }))!;
    assert.ok(notice, '추정치만 있는데 배지가 없다');
    assert.equal(notice.entirelyEstimated, true);
    assert.equal(notice.estimatedCount, 806);
    assert.equal(notice.totalCount, 806);
    // 무엇에서 파생됐는지까지 말한다 — 'parking_derived 806' 은 저장소를 아는 사람만 읽는다.
    assert.match(notice.badge, /주차 실측 기반 추정/);
    assert.match(notice.badge, /806/);
    assert.match(notice.detail, /현장 관측은 한 건도 없습니다/);
  }

  // ── 섞여 있으면 몫을 밝힌다 ────────────────────────────────────────────────
  {
    const notice = estimatedBasisNotice(day({ parking_derived: 800, user_report: 6 }))!;
    assert.equal(notice.entirelyEstimated, false, '실측이 6건 있는데 전부 추정이라고 말한다');
    assert.equal(notice.estimatedCount, 800);
    assert.equal(notice.totalCount, 806);
    assert.match(notice.detail, /806/);
    assert.match(notice.detail, /800/);
  }

  // ── 기존 데모 데이터(seed·simulated)도 같은 규칙으로 라벨한다 ──────────────
  // 새 source 만 라벨하고 옛 합성 데이터를 실측처럼 두면 라벨의 의미가 없다.
  {
    const notice = estimatedBasisNotice(day({ simulated: 1660, seed: 100, user_report: 1 }))!;
    assert.equal(notice.estimatedCount, 1760);
    assert.match(notice.badge, /데모 모의 생성/);
    assert.match(notice.badge, /개발 시드/);
    // 큰 몫이 먼저 온다.
    assert.ok(notice.badge.indexOf('데모 모의 생성') < notice.badge.indexOf('개발 시드'));
  }

  // ── 0 건짜리 항목은 배지를 만들지 않는다 ───────────────────────────────────
  assert.equal(estimatedBasisNotice(day({ parking_derived: 0, user_report: 5 })), null);

  // ── 라벨 사전이 실제 백엔드 값과 맞물려 있는가 ────────────────────────────
  assert.equal(ESTIMATED_LOG_SOURCES.parking_derived, '주차 실측 기반 추정');
  for (const key of ['parking_derived', 'seed', 'simulated']) {
    assert.ok(ESTIMATED_LOG_SOURCES[key], `${key} 라벨이 없다 — 화면에 코드가 그대로 나간다`);
  }

  // ── '주차 실측은 이 카드를 채우지 않는다' 는 더 이상 사실이 아니다 ────────
  // 다섯 번째 적재 경로가 생겼는데 안내 문구가 옛 사실을 말하면, 관리자는 값의 출처를
  // 영영 잘못 짚는다.
  assert.doesNotMatch(
    CONGESTION_INGEST_PATHS,
    /이 카드를 채우지 않습니다/,
    '주차 파생 적재 경로가 생겼는데 안내 문구가 옛 사실을 말한다',
  );
  assert.match(CONGESTION_INGEST_PATHS, /주차 실측 기반 추정/);
  assert.match(CONGESTION_INGEST_PATHS, /추정치입니다/, '파생 경로가 추정임을 말하지 않는다');

  console.log('estimatedBasisNotice.test.ts OK');
}

main();
