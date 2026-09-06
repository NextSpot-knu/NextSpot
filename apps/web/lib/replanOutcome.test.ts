// 재계획 결말 판정 — 장애를 '조건에 맞는 곳이 없음' 으로 말하던 자리라서 잠근다.
import assert from 'node:assert/strict';
import { classifyReplanOutcome, replanNotice, type ReplanOutcome } from './replanOutcome';
import ko from './i18n/messages/ko.json';

// --- 정상 응답 ---------------------------------------------------------------
assert.equal(
  classifyReplanOutcome({ timedOut: false, candidateCount: 3 }),
  'replaced',
  '후보가 있으면 갈아탄다',
);
assert.equal(
  classifyReplanOutcome({ timedOut: false, candidateCount: 0 }),
  'empty',
  '서버가 답했는데 0건이면 그것은 조건 문제다',
);

// --- ★ 예산 초과 — 예전에 '조건에 맞는 곳이 없어요' 로 나가던 자리 -----------
assert.equal(
  classifyReplanOutcome({ timedOut: true, candidateCount: 0 }),
  'timeout',
  '답을 못 받은 것을 0건으로 옮겨 적지 않는다',
);
assert.equal(
  classifyReplanOutcome({ timedOut: true, candidateCount: 2 }),
  'timeout',
  '예산을 넘긴 뒤 손에 든 후보는 이번 시도의 답이 아니다',
);

// --- 안내 문구와 재시도 경로 -------------------------------------------------
assert.equal(replanNotice('replaced'), null, '성공에는 할 말이 없다');

assert.deepEqual(
  replanNotice('empty'),
  { messageKey: 'map.noRecBody', retryable: false },
  '조건 문제에 재시도를 달면 같은 답이 나올 일을 시키는 것이다',
);

for (const outcome of ['timeout', 'failed'] as const) {
  assert.deepEqual(
    replanNotice(outcome),
    { messageKey: 'recommend.loadFailed', retryable: true },
    `${outcome} 은 장애다 — 조건 안내가 아니라 재시도 경로가 나가야 한다`,
  );
}

// 장애와 빈 결과가 같은 문구를 쓰면 이 수정의 의미가 사라진다.
assert.notEqual(
  replanNotice('failed')?.messageKey,
  replanNotice('empty')?.messageKey,
  '장애와 0건은 절대 같은 문구로 나가면 안 된다',
);

// --- 문구 키가 실제로 사전에 있는가 -----------------------------------------
// 이 키들은 t('...') 리터럴이 아니라 replanNotice 가 골라 넘긴다. scripts/check-i18n-keys.mjs
// 의 리터럴 스캔은 그런 호출을 보지 못하므로, 키 존재 확인을 여기서 대신 잠근다
// (사전에 없으면 사용자 화면에 'recommend.loadFailed' 라는 원시 키가 그대로 뜬다).
// en/ja/zh 는 lib/i18n/parity.test.ts 가 ko 기준으로 따로 검사한다.
function hasStringAt(tree: unknown, dotted: string): boolean {
  let current: unknown = tree;
  for (const part of dotted.split('.')) {
    if (current === null || typeof current !== 'object' || !(part in (current as object))) return false;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string';
}

for (const outcome of ['replaced', 'empty', 'timeout', 'failed'] as ReplanOutcome[]) {
  const notice = replanNotice(outcome);
  if (!notice) continue;
  assert.ok(hasStringAt(ko, notice.messageKey), `${outcome} 의 문구 키 ${notice.messageKey} 가 ko.json 에 없다`);
}

console.log('replanOutcome.test.ts OK');
