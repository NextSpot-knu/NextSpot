// escapeLikeTerm 만 검사한다 — searchFacilities 는 Supabase 네트워크가 필요하고,
// 이 파일에서 검증 가치가 있는 순수 결정은 '사용자가 친 글자가 와일드카드가 되지 않는가' 하나다.
import assert from 'node:assert/strict';
import { escapeLikeTerm } from './facilitySearch';

assert.equal(escapeLikeTerm('황리단길'), '황리단길', '평범한 검색어를 건드리면 안 된다');
assert.equal(escapeLikeTerm('커피 100%'), '커피 100\\%', '% 가 와일드카드로 새어 나갔다');
assert.equal(escapeLikeTerm('경주_카페'), '경주\\_카페', '_ 가 임의의 한 글자로 읽힌다');
assert.equal(escapeLikeTerm('a\\b'), 'a\\\\b', '이스케이프 문자 자신이 먼저 이스케이프돼야 한다');
// 순서가 틀리면 '\\%' 의 백슬래시를 나중에 다시 이스케이프해 '\\\\%' 가 된다(리터럴 % 가 아니게 된다).
assert.equal(escapeLikeTerm('\\%'), '\\\\\\%', '백슬래시를 % 보다 먼저 처리해야 한다');

console.log('facilitySearch.test.ts ok');
