// 30일 추이에서 '실측 계열' 로 넘어가는 문턱 테스트(I73).
//
// 대시보드(③ 30일 차트)와 성과 리포트(30일 추이·총평)가 같은 문턱을 써야 같은 응답이 두 화면에서 다른 이야기를
// 하지 않는다. 예전 리포트는 실측일이 하루만 있어도(심사위원의 좌석 방송 한 번, 관리자 수동 입력 한 번) 30일 추정
// 추이·총평을 통째로 걷어냈고, 대시보드는 3일부터 실측으로 넘어갔다.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIN_MEASURED_TREND_DAYS, hasMeasuredTrend } from './adminTrendThreshold';

assert.equal(MIN_MEASURED_TREND_DAYS, 3);
for (const days of [0, 1, 2]) assert.equal(hasMeasuredTrend(days), false, `실측 ${days}일은 추정 추이를 유지해야 한다`);
for (const days of [3, 4, 30]) assert.equal(hasMeasuredTrend(days), true, `실측 ${days}일이면 실측 추이로 넘어가야 한다`);
assert.equal(hasMeasuredTrend(Number.NaN), false);
assert.equal(hasMeasuredTrend(undefined), false);

// 두 화면이 같은 문턱을 부른다(숫자 3 을 각자 박지 않는다).
const WEB = process.cwd();
const strip = (s: string) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '');
const dashboard = strip(readFileSync(join(WEB, 'app/admin/dashboard/page.tsx'), 'utf8'));
const report = strip(readFileSync(join(WEB, 'app/admin/report/page.tsx'), 'utf8'));
assert.match(dashboard, /hasMeasuredTrend\(liveDays\)/, '대시보드 30일 차트가 공용 문턱을 쓰지 않는다');
assert.doesNotMatch(dashboard, /liveDays >= 3/, '대시보드가 문턱 숫자를 따로 박고 있다');
assert.match(report, /hasMeasuredTrend\(kpi\?\.sampleDays\)/, '성과 리포트가 공용 문턱을 쓰지 않는다');
assert.doesNotMatch(report, /sampleDays \?\? 0\) > 0/, '성과 리포트가 실측 하루만으로 추정 추이를 걷어낸다');
// 리뷰(10-07): 리포트 차트(TrendLineChart)도 같은 문턱이다. 차트가 따로 '실측 0일일 때만' 추정을 그리면, 실측 1~2일에
// 총평·추정 요약은 추정을 말하는데 차트는 '일평균 혼잡도(실측)' 점 한두 개를 그렸다.
{
  const chart = report.slice(report.indexOf('function TrendLineChart('));
  assert.ok(chart.length > 0 && report.includes('function TrendLineChart('), 'TrendLineChart 를 찾지 못했다');
  const gate = chart.match(/const showEstimate = ([^;]+);/);
  assert.ok(gate, 'TrendLineChart 의 추정 판정(showEstimate)을 찾지 못했다');
  assert.match(gate[1], /hasMeasuredTrend\(measured\.observed\)/, '리포트 차트가 공용 문턱으로 추정/실측을 고르지 않는다');
  assert.doesNotMatch(gate[1], /observed === 0/, '리포트 차트가 실측 하루만으로 추정 계열을 버린다');
}
// 내부 동기화 사정('동기화 마커 실측' · '적재 시각 추정')을 리포트 문구에 적지 않는다.
assert.doesNotMatch(report, /동기화 마커|적재 시각 추정/, '성과 리포트에 내부 동기화 용어가 남아 있다');

console.log('adminTrendThreshold.test.ts OK');
