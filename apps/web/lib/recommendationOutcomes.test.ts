import assert from 'node:assert/strict';
import { isPermanentFailure } from './recommendationOutcomes';
import { AuthError, HttpError, ServiceUnavailableError, httpStatus } from './api-client';

// 이 판정이 없으면 영구 실패 하나가 큐 맨 앞에 앉아 그 뒤 전부를 영영 막는다 —
// 단계 순서를 지키려고 실패 지점 이후를 통째로 되돌려 넣기 때문이다.

// ── httpStatus — 상태 코드를 잃지 않는가 ──────────────────────────────────
assert.equal(httpStatus(new HttpError('gone', 404)), 404);
assert.equal(httpStatus(new AuthError()), 401);
assert.equal(httpStatus(new ServiceUnavailableError()), 503);
// 상태가 없는 실패(네트워크 단절·abort·문자열 throw)는 undefined 여야 한다.
assert.equal(httpStatus(new Error('Failed to fetch')), undefined);
assert.equal(httpStatus('boom'), undefined);
assert.equal(httpStatus(null), undefined);

// ── 영구 실패 — 버린다 ────────────────────────────────────────────────────
for (const status of [400, 403, 404, 410, 422]) {
  assert.equal(isPermanentFailure(new HttpError('nope', status)), true, `${status} 가 재시도 대상이 됐다`);
}

// ── 일시적 실패 — 남긴다 ──────────────────────────────────────────────────
// 401 은 세션이 아직 안 붙었을 뿐이다(익명 세션 부트스트랩 레이스). 버리면 텔레메트리가 사라진다.
assert.equal(isPermanentFailure(new AuthError()), false, '401 을 버리면 세션 붙기 전 기록이 사라진다');
assert.equal(isPermanentFailure(new ServiceUnavailableError()), false);
for (const status of [408, 429, 500, 502, 504]) {
  assert.equal(isPermanentFailure(new HttpError('later', status)), false, `${status} 를 버렸다`);
}
// 409 는 "단계 순서가 올바르지 않습니다" 다 — 우리 큐가 만든 오류이므로 버리면 안 된다.
// 순서가 바로잡히면 다음 시도에 통과한다(안 되면 7일 컷오프가 걷어낸다).
assert.equal(
  isPermanentFailure(new HttpError('order', 409)),
  false,
  '409 를 버리면 우리가 만든 순서 오류로 멀쩡한 방문 기록을 지운다',
);

// 상태를 모르는 실패는 일시적으로 본다 — 모르면 재시도하는 쪽이 안전하다.
assert.equal(isPermanentFailure(new Error('Failed to fetch')), false);
assert.equal(isPermanentFailure(undefined), false);

console.log('recommendationOutcomes tests passed');
