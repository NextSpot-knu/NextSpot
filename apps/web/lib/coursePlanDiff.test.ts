// 재계획 문구 판정 — 이 판정이 실제로 거짓말을 한 적이 있어서 잠근다.
import assert from 'node:assert/strict';
import { describeReplan } from './coursePlanDiff';

const snap = (planId: string, ids: string[]) => ({ planId, ids });

// --- 판정할 근거가 없으면 말하지 않는다 -------------------------------------
assert.equal(describeReplan(null, snap('p1', ['A'])), null, '첫 로드에는 비교 대상이 없다');
assert.equal(describeReplan(snap('p1', ['A']), snap('', ['A'])), null, "planId 가 없으면(구 API) 지어내지 않는다");
assert.equal(describeReplan(snap('', ['A']), snap('p2', ['B'])), null, '이전 planId 가 없어도 마찬가지');

// --- 코스가 비면 토스트를 띄우지 않는다 -------------------------------------
// 화면은 이미 EmptyState 로 왜 비었는지 말한다. 그 위에 '다시 짰어요' 를 얹으면
// 0곳을 무언가 있는 것처럼 말하게 된다.
assert.equal(
  describeReplan(snap('p1', ['A', 'B', 'C']), snap('p2', [])),
  null,
  '빈 코스를 재계획 결과처럼 말하면 안 된다',
);

// --- 같으면 같다고 말한다 ----------------------------------------------------
assert.deepEqual(
  describeReplan(snap('p1', ['A', 'B']), snap('p1', ['A', 'B'])),
  { key: 'course.replanSame' },
);

// --- 순서만 바뀐 경우 --------------------------------------------------------
assert.deepEqual(
  describeReplan(snap('p1', ['A', 'B']), snap('p2', ['B', 'A'])),
  { key: 'course.replanReordered' },
  '집합이 같고 planId 만 다르면 순서가 바뀐 것이다',
);

// --- ★ 정류지가 빠진 경우 — 예전에 '순서만 바꿨다' 고 거짓말하던 자리 --------
assert.deepEqual(
  describeReplan(snap('p1', ['A', 'B', 'C']), snap('p2', ['A', 'B'])),
  { key: 'course.replanRemoved', vars: { n: 1 } },
  "정류지가 빠졌는데 '순서만 바꿨다' 고 말하면 두 가지가 다 거짓이다",
);

// --- 새로 들어온 경우 --------------------------------------------------------
assert.deepEqual(
  describeReplan(snap('p1', ['A']), snap('p2', ['A', 'B', 'C'])),
  { key: 'course.replanChanged', vars: { n: 2 } },
);

// --- 들어오고 빠진 것이 함께 있는 경우 ---------------------------------------
// 이것도 예전에는 added 만 세어 '2곳이 새로 바뀌었어요' 로 뭉개졌다 — 빠진 사실이 사라진다.
assert.deepEqual(
  describeReplan(snap('p1', ['A', 'B', 'C']), snap('p2', ['A', 'D', 'E'])),
  { key: 'course.replanSwapped', vars: { added: 2, removed: 2 } },
);

// --- 개수가 줄면서 집합도 바뀐 경우 ------------------------------------------
// '3곳이 새로 왔다' 로 포장되면 하나가 사라진 사실이 묻힌다.
assert.deepEqual(
  describeReplan(snap('p1', ['A', 'B', 'C']), snap('p2', ['D', 'E'])),
  { key: 'course.replanSwapped', vars: { added: 2, removed: 3 } },
);

// --- 중복 id 가 섞여도 개수가 부풀지 않는다 ----------------------------------
// (서버는 한 코스에 같은 시설을 두 번 넣지 않지만, 세는 쪽이 Set 기준이어야 안전하다.)
assert.deepEqual(
  describeReplan(snap('p1', ['A', 'A', 'B']), snap('p2', ['A', 'A'])),
  { key: 'course.replanRemoved', vars: { n: 1 } },
);

console.log('coursePlanDiff tests passed');
