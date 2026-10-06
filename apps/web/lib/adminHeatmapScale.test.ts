// 관제 히트맵 색 척도 · 30일 시나리오 축 테스트(I64 · I20, PM 결정 4.26).
//
// 잠그는 것:
//   (1) 관제 히트맵은 관광객 지도와 같은 네 등급(한산·여유·보통·혼잡), 같은 경계(25/50/혼잡 경계), 같은 색이다.
//       '매우 혼잡' 같은 관제 전용 등급과 '수집 중' 범례 칸은 없다(값이 없는 칸은 등급이 아니다).
//   (2) 시나리오 30일 차트는 실제 날짜가 아니라 '1일차…30일차' 축이다.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HEATMAP_GRADE_CLASS, heatmapCellClass, heatmapLegend } from './adminHeatmapScale';
import { congestionKey } from './congestionScale';
import { scenarioDayLabels } from './adminScenarioLabels';
import { demoAdminDistribution } from './demoFixtures';

// ── (1) 등급·색 ────────────────────────────────────────────────────────────────
{
  assert.equal(heatmapCellClass(null), null, '값이 없는 칸은 등급 색이 없다');
  assert.equal(heatmapCellClass(undefined), null);
  assert.equal(heatmapCellClass(0), HEATMAP_GRADE_CLASS.quiet, '0% 는 한산(측정한 값)');
  assert.equal(heatmapCellClass(0.24), 'bg-blue-500');
  assert.equal(heatmapCellClass(0.25), 'bg-emerald-500');
  assert.equal(heatmapCellClass(0.5), 'bg-amber-500');
  assert.equal(heatmapCellClass(0.74), 'bg-amber-500');
  assert.equal(heatmapCellClass(0.75), 'bg-red-500');
  // 경계는 지도와 같은 판정(congestionKey)을 쓴다 — 운영자가 '혼잡' 경계를 80% 로 옮기면 히트맵도 따라간다.
  for (const v of [0.1, 0.3, 0.55, 0.78, 0.82, 0.95]) {
    assert.equal(heatmapCellClass(v, 0.8), HEATMAP_GRADE_CLASS[congestionKey(v, 0.8)]);
  }
  // 지도 마커·열지도의 500 계열과 같은 색 이름.
  const markerSrc = readFileSync(join(process.cwd(), 'lib/map/heatmap.ts'), 'utf8');
  for (const [key, cls] of Object.entries(HEATMAP_GRADE_CLASS)) {
    const family = cls.replace('bg-', '').replace('-500', '');
    assert.match(markerSrc, new RegExp(`${key}:[^\\n]*${family}-500`), `${key} 색이 지도(${family}-500)와 다르다`);
  }
}

// ── (1) 범례 ───────────────────────────────────────────────────────────────────
{
  const legend = heatmapLegend();
  assert.deepEqual(legend.map((g) => g.label), ['한산 (0~25%)', '여유 (25~50%)', '보통 (50~75%)', '혼잡 (75%~)']);
  assert.deepEqual(heatmapLegend(0.8).map((g) => g.label), ['한산 (0~25%)', '여유 (25~50%)', '보통 (50~80%)', '혼잡 (80%~)']);
  // 경계가 50% 아래면 '보통' 이 사라진다(혼잡 판정이 먼저 — congestionKey 와 같은 규칙).
  assert.deepEqual(heatmapLegend(0.4).map((g) => g.key), ['quiet', 'relaxed', 'busy']);
  for (const g of legend) assert.doesNotMatch(g.label, /수집 중|매우 혼잡/);
}

// ── (1) 배선 — 히트맵 컴포넌트가 이 척도를 쓰고, 옛 척도·'수집 중' 범례가 돌아오지 않는다 ───────────
{
  const strip = (s: string) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '');
  const charts = strip(readFileSync(join(process.cwd(), 'components/admin/DashboardCharts.tsx'), 'utf8'));
  assert.match(charts, /heatmapCellClass\(value, busyAt\)/, '히트맵 칸 색이 공용 척도를 쓰지 않는다');
  assert.match(charts, /heatmapLegend\(busyAt\)/, '히트맵 범례가 공용 척도를 쓰지 않는다');
  assert.doesNotMatch(charts, /매우 혼잡|>수집 중<|bg-emerald-100/, '관제 전용 옛 척도·수집 중 범례가 남아 있다');
}

// ── (2) 시나리오 축 ────────────────────────────────────────────────────────────
{
  const rows = scenarioDayLabels(demoAdminDistribution());
  assert.equal(rows.length, 30);
  assert.equal(rows[0].date, '1일차');
  assert.equal(rows[29].date, '30일차');
  for (const row of rows) assert.doesNotMatch(row.date, /\//, '시나리오 축에 실제 날짜(M/D)가 남아 있다');
  // 값은 그대로다(축만 바뀐다).
  const raw = demoAdminDistribution();
  assert.equal(rows[10].afterCongestion, raw[10].afterCongestion);
}

console.log('adminHeatmapScale.test.ts OK');
