// 사진 후보 목록 — 대표 사진 → 갤러리 순, 빈 값 제거, 같은 URL 한 번. URL 문자열은 고치지 않는다.
import assert from 'node:assert/strict';
import { photoCandidates } from './photoCredit';

const A = 'https://tong.visitkorea.or.kr/cms/resource/01/a_image2_1.jpg';
const B = 'https://tong.visitkorea.or.kr/cms/resource/02/b_image2_1.jpg';
const W = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/X.jpg';

assert.deepEqual(photoCandidates(A, [B, W]), [A, B, W]);
assert.deepEqual(photoCandidates(null, [B]), [B]);
assert.deepEqual(photoCandidates('', [B]), [B]);
assert.deepEqual(photoCandidates('   ', [B]), [B]);
assert.deepEqual(photoCandidates(A, null), [A]);
assert.deepEqual(photoCandidates(A, undefined), [A]);
assert.deepEqual(photoCandidates(A, 'not-an-array'), [A]);
assert.deepEqual(photoCandidates(null, null), []);
// 대표 사진이 갤러리에 또 있으면 한 번만(처음 자리).
assert.deepEqual(photoCandidates(A, [A, B, B]), [A, B]);
// 문자열이 아닌 값은 빠진다.
assert.deepEqual(photoCandidates(42, [null, B, { url: A }]), [B]);
// 앞뒤 공백·스킴을 고치지 않는다 — 대기 보드 커서 키와 출처 판정이 URL 그대로 쓴다(기존 동작과 같다).
assert.deepEqual(photoCandidates(` ${A}`, []), [` ${A}`]);
assert.deepEqual(photoCandidates('http://tong.visitkorea.or.kr/x.jpg', []), ['http://tong.visitkorea.or.kr/x.jpg']);

console.log('photoCandidates: ok');
