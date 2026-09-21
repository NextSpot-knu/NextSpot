// 카운트업 보간 수학 — RAF 없이 순수 함수만 검증한다(훅 자체는 브라우저 전용).
// 핵심 계약: 최종값을 **절대 넘지 않는다**(정직성 — 실제 값 너머로 튀는 순간 지어낸 숫자다).
import assert from 'node:assert/strict';
import { countUpFrame, easeOutCubic } from './useCountUp';

// --- easeOutCubic 경계 ---------------------------------------------------------
assert.equal(easeOutCubic(0), 0, '시작은 0');
assert.equal(easeOutCubic(1), 1, '끝은 정확히 1');
// 범위 밖 입력은 클램프 — RAF 마지막 프레임이 duration 을 넘겨도 오버슈트 금지.
assert.equal(easeOutCubic(1.5), 1, '1 초과 진행률은 1로 클램프');
assert.equal(easeOutCubic(-0.5), 0, '음수 진행률은 0으로 클램프');
// ease-out: 전반부가 후반부보다 빠르다(중간 지점에서 이미 절반 이상 도달).
assert.ok(easeOutCubic(0.5) > 0.5, '감속 곡선 — 중간에 절반 이상 진행');
// 단조 증가 — 표시값이 뒤로 가며 흔들리면 살아 있는 게 아니라 고장으로 보인다.
for (let i = 1; i <= 100; i++) {
  assert.ok(easeOutCubic(i / 100) >= easeOutCubic((i - 1) / 100), `단조 증가 위반 @${i / 100}`);
}

// --- countUpFrame 보간 ----------------------------------------------------------
assert.equal(countUpFrame(0, 100, 0), 0, '진행 0 = 시작값');
assert.equal(countUpFrame(0, 100, 1), 100, '진행 1 = 정확히 목표값');
assert.equal(countUpFrame(0, 100, 2), 100, '진행률 오버런에도 목표값 초과 금지');
// 목표값을 절대 넘지 않는다(증가 방향).
for (let i = 0; i <= 120; i++) {
  const v = countUpFrame(0, 87, i / 100, 0);
  assert.ok(v >= 0 && v <= 87, `0..87 범위 이탈: ${v} @${i / 100}`);
}
// 값이 **내려가는** 갱신(예: 혼잡도 하락)도 목표 아래로 언더슈트하지 않는다.
for (let i = 0; i <= 120; i++) {
  const v = countUpFrame(90, 40, i / 100, 1);
  assert.ok(v >= 40 && v <= 90, `90→40 범위 이탈: ${v} @${i / 100}`);
}
assert.equal(countUpFrame(90, 40, 1, 1), 40, '하락 방향도 최종값 정확 도달');

// --- 소수 자리 반올림 ------------------------------------------------------------
assert.equal(countUpFrame(0, 12.3, 1, 1), 12.3, 'decimals=1 이면 0.1 단위 표시');
assert.equal(countUpFrame(0, 12.3, 1, 0), 12, 'decimals=0 이면 정수 표시');
// 음수·소수 decimals 방어 — 정수 0 이상으로 취급.
assert.equal(countUpFrame(0, 55, 1, -2), 55, '음수 decimals 는 0으로');

// 중간값이 실제로 움직인다(0에 머물지 않음) — "굴러간다"는 연출의 최소 보증.
assert.ok(countUpFrame(0, 100, 0.3) > 0, '중간 진행률에서 표시값이 전진');

console.log('useCountUp.test.ts OK');
