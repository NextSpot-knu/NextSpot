import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeObservationGap, type LastObservation } from './adminObservationGap';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');

// 프로덕션 실측(2026-09-08 anon GET): congestion_logs 최신 행 = 2026-08-20T17:05:51Z.
const LAST_REAL = '2026-08-20T17:05:51.889315+00:00';
const NOW = Date.parse('2026-09-08T03:00:00Z');

async function main() {
  // ── 창이 비었을 때: 지금 무엇이 보이고 다음에 무엇이 채워지는지 말한다 ──────
  const gap = describeObservationGap({ status: 'at', iso: LAST_REAL }, 14, NOW);
  assert.match(gap, /최근 14일/, "어느 창을 봤는지 말하지 않으면 안내의 범위를 알 수 없다");
  assert.match(gap, /다음 수집 주기에 반영됩니다/, '다음에 무엇이 일어나는지를 말한다');
  assert.match(gap, /추정 지표를 아래에 제공합니다/, '지금 화면에 무엇이 보이는지를 말한다');
  assert.doesNotMatch(
    gap,
    /없습니다/,
    "문장이 '없습니다' 로 끝나면 '원래 데이터가 없는 서비스' 로 읽힌다",
  );

  // ── 내부 사정은 화면에 새지 않는다 ───────────────────────────────────────────
  const cases: LastObservation[] = [
    { status: 'unknown' },
    { status: 'none' },
    { status: 'at', iso: LAST_REAL },
    { status: 'at', iso: 'not-a-date' },
    { status: 'at', iso: '2026-10-01T00:00:00Z' }, // 미래 시각
  ];
  for (const c of cases) {
    const text = describeObservationGap(c, 14, NOW);
    assert.match(text, /최근 14일/, `창 길이가 빠졌다: ${c.status}`);
    assert.doesNotMatch(text, /\d+일 전/, `경과일이 화면에 샜다: ${text}`);
    assert.doesNotMatch(text, /월 \d+일/, `마지막 관측 날짜가 화면에 샜다: ${text}`);
    assert.doesNotMatch(text, /not-a-date/, `원문 값이 화면에 샜다: ${text}`);
    assert.doesNotMatch(text, /실패|못했|미래/, `내부 사정이 화면에 샜다: ${text}`);
  }

  // ── 창 길이는 호출부가 정한다(14일은 이 화면의 값일 뿐) ─────────────────────
  assert.match(describeObservationGap({ status: 'at', iso: LAST_REAL }, 7, NOW), /최근 7일/);

  // ── 배선 확인: 화면이 실제로 이 판정을 쓰는가 ───────────────────────────────
  const reportsSrc = readFileSync(join(WEB, 'app', 'admin', 'reports', 'page.tsx'), 'utf8');
  assert.match(reportsSrc, /describeObservationGap\(/, "리포트 화면이 빈 14일 창을 '데이터 없음' 으로만 말한다");
  assert.match(reportsSrc, /fetchLastObservation/, '마지막 관측 조회 배선이 사라지면 상태 판정이 무너진다');

  console.log('admin observation gap tests passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
