import assert from 'node:assert/strict';
import { errorMessageFrom } from './api-client';

// 화면에 "[object Object]" 가 뜨던 자리. FastAPI 의 요청 검증 실패(422)는 detail 을
// 문자열이 아니라 {loc, msg, type} 객체 배열로 준다. 그걸 그대로 Error 메시지에 넣으면
// 사용자에게도 우리에게도 아무 정보가 없는 문자열이 남는다.

// 이 저장소의 HTTPException 은 전부 문자열 detail 이다 — 그 경로가 1순위.
assert.equal(errorMessageFrom({ detail: '이미 심사를 기다리는 신청이 있습니다.' }, 409),
  '이미 심사를 기다리는 신청이 있습니다.');

// 422 배열 detail — 첫 항목의 msg 를 꺼낸다.
assert.equal(
  errorMessageFrom({ detail: [{ loc: ['body', 'last4'], msg: 'ensure this value has at most 4 characters', type: 'value_error' }] }, 422),
  'ensure this value has at most 4 characters',
);

// msg 가 없는 배열이면 상태 코드로 떨어진다("[object Object]" 를 만들지 않는다).
assert.equal(errorMessageFrom({ detail: [{ loc: ['body'] }] }, 422), 'HTTP error! status: 422');
assert.equal(errorMessageFrom({ detail: [] }, 422), 'HTTP error! status: 422');

// detail 이 객체이거나 없는 경우 — 예전에는 여기서 "[object Object]" 가 나왔다.
assert.equal(errorMessageFrom({ detail: { msg: 'nope' } }, 400), 'HTTP error! status: 400');
assert.equal(errorMessageFrom({}, 500), 'HTTP error! status: 500');
assert.equal(errorMessageFrom(null, 502), 'HTTP error! status: 502');
assert.equal(errorMessageFrom('그냥 문자열', 503), 'HTTP error! status: 503');

// 빈 문자열 detail 도 폴백이다 — 빈 토스트를 띄우지 않는다.
assert.equal(errorMessageFrom({ detail: '' }, 400), 'HTTP error! status: 400');

// 어떤 입력에도 "[object Object]" 가 새어 나오면 안 된다.
for (const body of [{ detail: [{}] }, { detail: {} }, { detail: [1, 2] }, { detail: undefined }]) {
  assert.ok(!errorMessageFrom(body, 422).includes('[object'), `누수: ${JSON.stringify(body)}`);
}

console.log('api-client error message tests passed');
