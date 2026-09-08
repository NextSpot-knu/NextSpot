import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeObservationGap, type LastObservation } from './adminObservationGap';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');

// 프로덕션 실측(2026-09-08 anon GET): congestion_logs 최신 행 = 2026-08-20T17:05:51Z.
// KST 로는 8월 21일 02:05 이므로 화면 라벨은 '8월 21일' 이어야 한다.
const LAST_REAL = '2026-08-20T17:05:51.889315+00:00';
const NOW = Date.parse('2026-09-08T03:00:00Z');

async function main() {
  // ── 창이 비었을 뿐인 경우: 마지막 관측 시각을 사실로 말한다 ──────────────────
  const gap = describeObservationGap({ status: 'at', iso: LAST_REAL }, 14, NOW);
  assert.match(gap, /최근 14일/, "어느 창을 봤는지 말하지 않으면 '없다' 의 범위를 알 수 없다");
  assert.match(gap, /8월 21일/, 'KST 기준 마지막 관측 날짜를 보여야 한다(리포트의 요일 버킷과 같은 기준)');
  assert.match(gap, /18일 전/, '얼마나 멈춰 있는지가 관리자의 판단 근거다');
  assert.doesNotMatch(
    gap,
    /없습니다\.$/,
    "문장이 '없습니다' 로 끝나면 '원래 데이터가 없는 서비스' 로 읽힌다",
  );

  // ── 조회 실패는 '기록 없음' 이 아니다 ────────────────────────────────────────
  const unknown = describeObservationGap({ status: 'unknown' }, 14, NOW);
  const none = describeObservationGap({ status: 'none' }, 14, NOW);
  assert.notEqual(unknown, none, "마지막 관측 조회 실패를 '기록 없음' 으로 말하면 장애가 숨는다");
  assert.match(unknown, /확인하지 못했/, '모르는 것은 모른다고 해야 한다');
  assert.match(none, /수집이 아직 시작되지 않았/, '진짜로 한 건도 없는 경우는 그렇게 말한다');
  assert.doesNotMatch(unknown, /\d+일 전/, '확인하지 못한 시각으로 경과일을 지어내지 않는다');

  // ── 창 길이는 호출부가 정한다(14일은 이 화면의 값일 뿐) ─────────────────────
  assert.match(describeObservationGap({ status: 'at', iso: LAST_REAL }, 7, NOW), /최근 7일/);

  // ── 오늘 관측이 있는데 창이 비는 경우(창을 좁게 잡은 화면) ──────────────────
  const today = describeObservationGap(
    { status: 'at', iso: '2026-09-08T01:00:00Z' },
    14,
    NOW,
  );
  assert.match(today, /오늘/, "0일 전을 '0일 전' 이라고 쓰면 어색하고 오해를 부른다");
  assert.doesNotMatch(today, /0일 전/);

  // ── 못 읽는 시각·미래 시각: 조용히 뭉개지 않는다 ────────────────────────────
  const broken = describeObservationGap({ status: 'at', iso: 'not-a-date' }, 14, NOW);
  assert.match(broken, /읽지 못했/, '파싱 실패를 기록 없음으로 떨어뜨리면 또 사실이 뭉개진다');
  assert.match(broken, /not-a-date/, '무엇을 못 읽었는지 원문을 남긴다');
  const future = describeObservationGap({ status: 'at', iso: '2026-10-01T00:00:00Z' }, 14, NOW);
  assert.match(future, /미래/, "미래 시각에 '-23일 전' 같은 값을 만들어 붙이지 않는다");
  assert.doesNotMatch(future, /-\d+일/);

  // 날짜 경계: UTC 로는 하루 전이어도 KST 로는 다음 날이다(23:00Z → 익일 08:00 KST).
  const boundary = describeObservationGap(
    { status: 'at', iso: '2026-08-31T23:00:00Z' },
    14,
    Date.parse('2026-09-08T00:00:00Z'),
  );
  assert.match(boundary, /9월 1일/, 'UTC 날짜를 그대로 쓰면 하루 어긋난 날짜를 보여준다');

  // 모든 분기가 창 길이를 밝힌다.
  const cases: LastObservation[] = [
    { status: 'unknown' },
    { status: 'none' },
    { status: 'at', iso: LAST_REAL },
    { status: 'at', iso: 'not-a-date' },
  ];
  for (const c of cases) {
    assert.match(describeObservationGap(c, 14, NOW), /최근 14일/, `창 길이가 빠졌다: ${c.status}`);
  }

  // ── 배선 확인: 화면이 실제로 마지막 관측을 조회해서 쓰는가 ──────────────────
  const reportsSrc = readFileSync(join(WEB, 'app', 'admin', 'reports', 'page.tsx'), 'utf8');
  assert.match(reportsSrc, /describeObservationGap\(/, "리포트 화면이 빈 14일 창을 '데이터 없음' 으로만 말한다");
  assert.match(reportsSrc, /fetchLastObservation/, '마지막 관측 시각을 조회하지 않으면 사실을 말할 수 없다');

  console.log('admin observation gap tests passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
