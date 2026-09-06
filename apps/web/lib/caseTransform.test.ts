// 키 변환 — **레포 전체 API 계약의 경계**라서 잠근다.
//
// 이 모듈은 테스트를 붙이려고 api-client.ts 에서 빼낸 것인데(파일 상단 주석 참조) 정작
// 테스트가 없었다. 그 사이에 실제로 계약이 어긋났다: /lab/pending 응답의 `id`/`created_at`
// 을 프런트 타입이 `feedbackId`/`recommendedAt` 으로 선언해 두는 바람에 모든 값이 undefined
// 였고, 버튼은 `/api/v1/lab/undefined/reason` 을 때렸다. tsc 도 빌드도 초록이었다.
// (그 계약 자체는 이제 apps/api 쪽 패리티 테스트가 잡는다:
//  tests/routers/test_lab.py::test_pending_item_contract_parity_with_web)
import assert from 'node:assert/strict';
import { snakeToCamel, camelToSnake, keysToCamel, keysToSnake } from './caseTransform';

// --- 문자열 단위 -------------------------------------------------------------
assert.equal(snakeToCamel('facility_id'), 'facilityId');
assert.equal(snakeToCamel('already'), 'already');
assert.equal(camelToSnake('facilityId'), 'facility_id');
assert.equal(camelToSnake('already'), 'already');

// --- 응답 방향: 화면이 보는 것은 언제나 camelCase ----------------------------
assert.deepEqual(
  keysToCamel({ facility_id: 'f1', recommendation_id: 'r1', created_at: 'T' }),
  { facilityId: 'f1', recommendationId: 'r1', createdAt: 'T' },
);

// 중첩·배열까지 재귀한다(중첩이 안 되면 상세 카드가 통째로 빈다).
assert.deepEqual(
  keysToCamel({ slot_outcomes: [{ facility_id: 'a', is_pinned: true }] }),
  { slotOutcomes: [{ facilityId: 'a', isPinned: true }] },
);

// 값은 건드리지 않는다 — 값 안의 snake_case 문자열까지 바꾸면 id 가 깨진다.
assert.deepEqual(keysToCamel({ reason_status: 'too_far' }), { reasonStatus: 'too_far' });

// null/undefined 는 그대로 통과한다(응답이 null 인 엔드포인트가 있다).
assert.equal(keysToCamel(null), null);
assert.equal(keysToCamel(undefined), undefined);
assert.deepEqual(keysToCamel({ vector: null }), { vector: null });

// 최상위 배열 응답(/courses/recommend 등 구 계약)도 변환된다.
assert.deepEqual(keysToCamel([{ facility_id: 'a' }]), [{ facilityId: 'a' }]);

// --- 요청 방향: 서버가 보는 것은 언제나 snake_case --------------------------
assert.deepEqual(
  keysToSnake({ maxWalkMinutes: 15, requiredAttributes: ['wheelchair'] }),
  { max_walk_minutes: 15, required_attributes: ['wheelchair'] },
);
assert.deepEqual(
  keysToSnake({ pins: [{ facilityId: 'f1', order: 1 }] }),
  { pins: [{ facility_id: 'f1', order: 1 }] },
);

// --- ⚠️ 왕복이 무손실이 아니다 — 숫자 구간이 있는 키 -------------------------
// `_2` 는 `(_\w)` 에 걸리는데 숫자에는 대문자가 없어 구분자만 사라진다. 그래서
// snake → camel → snake 가 원래 키로 돌아오지 않는다. 지금은 이런 키
// (facility_count_after_2km_propagation, name_50m 등)가 **응답 전용**이라 무해하지만,
// 같은 모양의 키를 요청 본문에 넣으면 서버가 못 알아듣는다. 그때 여기서 걸리라고 박아 둔다.
assert.equal(snakeToCamel('facility_count_after_2km_propagation'), 'facilityCountAfter2kmPropagation');
assert.equal(
  camelToSnake(snakeToCamel('facility_count_after_2km_propagation')),
  'facility_count_after2km_propagation',
  '왕복이 무손실이 아니다 — 이 동작을 바꾸려면 요청/응답 양쪽을 함께 봐야 한다',
);

console.log('caseTransform tests passed');
