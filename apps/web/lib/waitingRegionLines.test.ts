// /waiting 의 보드 한 줄 — 내부 검증 지역에서 경주 문구('지금 경주 시내 중심 … · 추정', '…황리단길에서 출발한 기준')가
// 서지 않는지 화면 배선을 잠근다. 판정 자체는 lib/boardOrder.test.ts(boardCrowdView)가 잠근다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const page = readFileSync(join(__dirname, '..', 'app', 'waiting', 'page.tsx'), 'utf8');

assert.match(page, /boardCrowdView\(uniformLevels, busyAt, \{ isPublic, zoneLineShown: !isPublic && areaZoneLine !== null \}\)/);
// 범례는 지역별 키 — 경주 키를 직접 부르지 않는다.
assert.doesNotMatch(page, /t\("wait\.legendUniform"\)/, '서울 보드에 황리단길 범례가 선다');
assert.match(page, /t\(boardCrowd\.legendUniformKey\)/);
// 경주 한 줄은 boardCrowd.areaLine(공개 지역 + 한 등급)일 때만.
const areaLine = page.indexOf('data-testid="waiting-area-line"');
const gate = page.lastIndexOf('{boardCrowd.areaLine && crowdSpread.grade && (', areaLine);
assert.ok(gate > 0 && areaLine - gate < 200, '경주 한 줄이 지역 판정 밖에 있다');
// 구역 줄 판정이 보드 한 줄 판정보다 먼저 계산된다(접을지 말지가 구역 줄에 달렸다).
assert.ok(page.indexOf('const areaZoneView = (() => {') > 0);
assert.ok(page.indexOf('const areaZoneLine = areaZoneView?.text ?? null;') < page.indexOf('const boardCrowd = boardCrowdView('));
// 구역 줄의 점은 말하는 단계의 등급색이다(카드 · 코스 칩과 같은 표) — 늘 한산 색(bg-jade)인 점을 두지 않는다.
const zoneLine = page.indexOf('data-testid="waiting-zone-line"');
const zoneLineBlock = page.slice(zoneLine, zoneLine + 400);
assert.match(zoneLineBlock, /crowdKeyDot\(areaZoneView\.grade\)/, '구역 줄 점이 단계 색을 따르지 않는다');
assert.doesNotMatch(zoneLineBlock, /rounded-full bg-jade/, '구역 줄 점이 늘 한산 색이다');
assert.match(page, /const grade = zoneBandGrade\(band\);/);

console.log('waitingRegionLines.test.ts OK');
