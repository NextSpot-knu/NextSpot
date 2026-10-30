// 관제 경보 기준이 한 숫자인지 — 웹 상수 · 서버 상수 · 화면 배선(P0-4).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ADMIN_ALERT_LEVEL, ADMIN_WARN_LEVEL, levelPercent } from './adminAlertLevels';
import { PREDICTED_ANOMALY_THRESHOLD } from './adminPredictedView';

const WEB = process.cwd();
const read = (p: string) => readFileSync(join(WEB, p), 'utf8');
const strip = (s: string) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '');

assert.equal(ADMIN_ALERT_LEVEL, 0.9);
assert.equal(ADMIN_WARN_LEVEL, 0.7);
assert.equal(levelPercent(ADMIN_ALERT_LEVEL), 90);
assert.equal(levelPercent(ADMIN_WARN_LEVEL), 70);
// 예측 피크의 '이상' 기준도 같은 상수다.
assert.equal(PREDICTED_ANOMALY_THRESHOLD, ADMIN_ALERT_LEVEL);

// ── 서버 정본과 같은가 ────────────────────────────────────────────────────────
{
  const estimator = read('../api/app/services/congestion_estimator_service.py');
  const m = estimator.match(/^ANOMALY_LEVEL = ([\d.]+)/m);
  assert.ok(m, 'congestion_estimator_service.py 에서 ANOMALY_LEVEL 을 찾지 못했다');
  assert.equal(Number(m[1]), ADMIN_ALERT_LEVEL, '웹 경보 기준이 서버 ANOMALY_LEVEL 과 다르다');

  const safety = read('../api/app/routers/safety.py');
  assert.match(safety, /^DEFAULT_ALERT_THRESHOLD = ANOMALY_LEVEL$/m, '안전 경보 기본값이 대시보드 이상 기준 상수가 아니다');
  const warn = safety.match(/^DEFAULT_WARN_THRESHOLD = ([\d.]+)/m);
  assert.ok(warn, 'safety.py 에서 DEFAULT_WARN_THRESHOLD 를 찾지 못했다');
  assert.equal(Number(warn[1]), ADMIN_WARN_LEVEL, '웹 주의 기준이 서버 기본값과 다르다');
}

// ── 화면이 숫자를 따로 박지 않는다 ──────────────────────────────────────────────
{
  const safetyPage = strip(read('app/admin/safety/page.tsx'));
  assert.match(safetyPage, /levelPercent\(ADMIN_ALERT_LEVEL\)/, '안전 화면 경보 기본값이 공용 상수가 아니다');
  assert.match(safetyPage, /levelPercent\(ADMIN_WARN_LEVEL\)/, '안전 화면 주의 기본값이 공용 상수가 아니다');
  assert.doesNotMatch(safetyPage, /DEFAULT_ALERT_PCT = 85/, '안전 화면이 옛 경보 기준(85%)을 쓴다');
}

console.log('adminAlertLevels tests passed');
