import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GAP_SHADING_NOTE,
  MIN_SHADED_GAP_DAYS,
  findGaps,
  formatGapLabel,
  formatGapNote,
  isMissingValue,
  longestGap,
  summarizeSeries,
} from './adminSeriesGaps';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');

interface Row {
  date: string;
  avgCongestion: number | null;
  acceptShare: number | null;
}

/** '_' = 결측. 한 줄로 창 모양을 적을 수 있어 케이스가 눈에 들어온다. */
function rows(congestion: string, accept = congestion): Row[] {
  return [...congestion].map((c, i) => ({
    date: `9/${i + 1}`,
    avgCongestion: c === '_' ? null : Number(c) / 10,
    acceptShare: accept[i] === '_' ? null : Number(accept[i]) / 10,
  }));
}

async function main() {
  // ── 실측 0 은 결측이 아니다 ─────────────────────────────────────────────────
  // 이 파일 전체가 지키려는 사실. 0 을 결측으로 세는 순간 '한산했던 날' 이 '기록 없는 날' 이 된다.
  assert.equal(isMissingValue(0), false, '실측 0.0 을 결측으로 세면 한산한 날이 사라진다');
  assert.equal(isMissingValue(null), true);
  assert.equal(isMissingValue(undefined), true);
  assert.equal(isMissingValue(Number.NaN), true, 'NaN 은 그려도 선이 끊긴다 — 결측으로 다룬다');

  {
    const zeroDay = summarizeSeries(rows('050'), (r) => r.avgCongestion);
    assert.equal(zeroDay.observed, 3, '0 인 날도 관측일이다');
    assert.equal(zeroDay.missingDays, 0);
    assert.deepEqual(zeroDay.gaps, [], '0 이 이어져도 음영을 칠하지 않는다');
    assert.deepEqual(zeroDay.min, { date: '9/1', value: 0 }, '최저 0% 는 실제로 있었던 값이다');
  }

  // ── 결측 구간 찾기 ──────────────────────────────────────────────────────────
  {
    // 앞 2일 · 중간 3일 · 끝 1일 결측.
    const s = summarizeSeries(rows('__55___55_'), (r) => r.avgCongestion);
    assert.equal(s.total, 10);
    assert.equal(s.observed, 4);
    assert.equal(s.missingDays, 6, '1일짜리 결측도 미관측 일수에는 들어간다');
    assert.deepEqual(
      s.gaps,
      [
        { from: '9/1', to: '9/2', days: 2 },
        { from: '9/5', to: '9/7', days: 3 },
      ],
      '앞머리 구간과 중간 구간을 모두 찾아야 한다',
    );
  }

  // 1일짜리 결측은 음영 대상이 아니다 — 카테고리 축에서 x1===x2 면 폭 0이라 아예 안 그려진다.
  {
    const s = summarizeSeries(rows('5_5'), (r) => r.avgCongestion);
    assert.deepEqual(s.gaps, [], '1일 결측은 끊긴 선 자체로 드러난다');
    assert.equal(s.missingDays, 1, '그래도 캡션에는 세어 말해야 한다');
    assert.equal(MIN_SHADED_GAP_DAYS, 2);
  }

  // 마지막 칸에서 끝나는 구간을 놓치지 않는가(루프가 닫히는 자리).
  {
    const tail = summarizeSeries(rows('55___'), (r) => r.avgCongestion);
    assert.deepEqual(tail.gaps, [{ from: '9/3', to: '9/5', days: 3 }], '꼬리 구간이 잘리면 안 된다');

    const head = summarizeSeries(rows('___55'), (r) => r.avgCongestion);
    assert.deepEqual(head.gaps, [{ from: '9/1', to: '9/3', days: 3 }]);

    const all = summarizeSeries(rows('____'), (r) => r.avgCongestion);
    assert.deepEqual(all.gaps, [{ from: '9/1', to: '9/4', days: 4 }], '창 전체가 비면 한 구간이다');
    assert.equal(all.avg, null, '관측이 없으면 평균을 지어내지 않는다');
    assert.equal(all.max, null);
  }

  // 창이 비었을 때(행 0개) — 차트를 그리기 전에 부르는 자리라 던지면 안 된다.
  {
    const empty = summarizeSeries([] as Row[], (r) => r.avgCongestion);
    assert.deepEqual(empty, {
      observed: 0, total: 0, avg: null, max: null, min: null, gaps: [], missingDays: 0,
    });
  }

  // ── 요약값 ─────────────────────────────────────────────────────────────────
  {
    const s = summarizeSeries(rows('2_86'), (r) => r.avgCongestion);
    assert.equal(s.observed, 3);
    assert.ok(Math.abs((s.avg as number) - 0.5333333) < 1e-6, '평균은 관측일만으로 낸다(결측을 0으로 채우지 않는다)');
    assert.deepEqual(s.max, { date: '9/3', value: 0.8 });
    assert.deepEqual(s.min, { date: '9/1', value: 0.2 });
  }

  // ── 계열이 둘인 차트: '둘 다 없는 날' 만 음영 ──────────────────────────────
  // 대시보드는 한 차트에 혼잡도·수락률을 함께 그린다. 한쪽만 없는 날까지 덮으면
  // 있는 관측을 없다고 말하는 셈이 된다.
  {
    //          9/1 9/2 9/3 9/4
    //   혼잡도   _   _   _   5
    //   수락률   5   _   _   5   → 둘 다 없는 날은 9/2~9/3 뿐이다.
    const data = rows('___5', '5__5');
    const both = findGaps(data, (r) => isMissingValue(r.avgCongestion) && isMissingValue(r.acceptShare));
    assert.deepEqual(both, [{ from: '9/2', to: '9/3', days: 2 }], '겹치는 구간만 덮어야 한다');

    const congestionOnly = summarizeSeries(data, (r) => r.avgCongestion);
    assert.deepEqual(
      congestionOnly.gaps,
      [{ from: '9/1', to: '9/3', days: 3 }],
      '계열 하나만 보면 그 계열의 결측 구간 전체가 나온다(음영 대상과는 다르다)',
    );
  }

  // ── 문구 ───────────────────────────────────────────────────────────────────
  {
    assert.equal(formatGapLabel({ from: '8/19', to: '8/21', days: 3 }), '미관측 3일 (8/19~8/21)');

    const note = formatGapNote(6) as string;
    assert.match(note, /선을 잇지 않고/, '왜 선이 끊겼는지를 말해야 한다');
    assert.match(note, /0%가 아님/, "이 괄호가 이 문장의 존재 이유다 — 빈 구간이 '0' 으로 읽히면 안 된다");
    assert.equal(formatGapNote(0), null, '결측이 없으면 아무 말도 하지 않는다');
    assert.equal(formatGapNote(-1), null);

    // 계열이 둘인 차트용 문장 — 일수를 말하지 않는 대신 음영의 의미를 밝힌다.
    assert.match(GAP_SHADING_NOTE, /선을 잇지 않/, '두 화면이 같은 정책을 말해야 한다');
    assert.match(GAP_SHADING_NOTE, /0%가 아/, '빈 구간이 0 으로 읽히면 안 된다는 사실이 빠지면 안 된다');
    assert.doesNotMatch(
      GAP_SHADING_NOTE,
      /미관측 \d+일/,
      '계열마다 결측일이 다른데 한 숫자로 말하면 그 숫자가 어느 계열의 것인지 알 수 없다',
    );
  }

  {
    assert.equal(longestGap([]), null);
    assert.deepEqual(
      longestGap([
        { from: '9/1', to: '9/2', days: 2 },
        { from: '9/5', to: '9/8', days: 4 },
        { from: '9/11', to: '9/13', days: 3 },
      ]),
      { from: '9/5', to: '9/8', days: 4 },
      '라벨은 가장 긴 구간 하나에만 붙는다(겹쳐서 안 읽히지 않도록)',
    );
  }

  // ── 배선 확인: 두 화면이 정말 같은 판정을 쓰는가 ───────────────────────────
  // 이 묶음이 있는 이유가 "같은 데이터를 두 화면이 다르게 그린다" 였다. 소스에서 잠근다.
  const screens = [
    join(WEB, 'app', 'admin', 'report', 'page.tsx'),
    join(WEB, 'components', 'admin', 'DashboardCharts.tsx'),
  ];
  for (const path of screens) {
    const src = readFileSync(path, 'utf8');
    const name = path.split(/[\\/]/).slice(-2).join('/');
    assert.match(src, /from '@\/lib\/adminSeriesGaps'/, `${name} 가 공용 결측 판정을 쓰지 않는다`);
    // 주석을 걷어낸 뒤 본다 — 주석 속 'connectNulls' 설명에 걸리지 않게.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(
      code,
      /connectNulls(?!=\{false\})/,
      `${name} 가 결측을 직선으로 잇는다 — 없는 관측을 그리는 것이다`,
    );
    assert.match(code, /connectNulls=\{false\}/, `${name} 에 결측 정책이 명시돼 있지 않다`);
    assert.match(code, /ReferenceArea/, `${name} 가 결측 구간을 음영으로 표시하지 않는다`);
  }

  console.log('admin series gap tests passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
