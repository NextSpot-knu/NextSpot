// 사용자 데이터 격리 — 지우는 키 목록과 익명 번호 초기화.
import assert from 'node:assert/strict';

import { COURSE_CACHE_KEY } from '../../features/course/model';
import { SEEN_REPLIES_KEY } from '../../features/mypage/inquiryCore';
import { HIDDEN_PHOTOS_KEY } from '../../features/recommendation-card/photoSafety';
import { ANON_ID_KEY, clearUserScopedData, reconcileUserData, USER_SCOPED_KEYS } from './userData';

function memoryStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    keys: () => [...m.keys()],
  };
}

// 앱이 쓰는 개인 데이터 키가 목록에 있다(키 이름은 각 모듈의 상수와 같아야 한다).
for (const key of [
  COURSE_CACHE_KEY,
  'nextspot_taste_feedback_v1',
  HIDDEN_PHOTOS_KEY,
  'nextspot_recommendation_outcome_queue',
  SEEN_REPLIES_KEY,
]) {
  assert.ok((USER_SCOPED_KEYS as readonly string[]).includes(key), `${key} 는 사용자 데이터`);
}
assert.equal(ANON_ID_KEY, 'nextspot_anon_id');

// 데이터 삭제 — 개인 데이터와 익명 번호를 지우고, 기기 설정·위치 동의는 남긴다.
{
  const s = memoryStore();
  for (const key of USER_SCOPED_KEYS) s.setItem(key, 'x');
  s.setItem(ANON_ID_KEY, 'anon-old');
  s.setItem('nextspot_locale', 'en');
  s.setItem('nextspot_location_consent', '{}');
  clearUserScopedData(s);
  assert.deepEqual(s.keys().sort(), ['nextspot_locale', 'nextspot_location_consent'], '개인 데이터·익명 번호는 남지 않는다');
}

// 키 하나를 지우다 실패해도 나머지는 지운다.
{
  const s = memoryStore();
  s.setItem('nextspot_saved_facilities', '[1]');
  s.setItem(ANON_ID_KEY, 'anon-old');
  const flaky = {
    ...s,
    removeItem: (k: string) => {
      if (k === USER_SCOPED_KEYS[0]) throw new Error('blocked');
      s.removeItem(k);
    },
  };
  clearUserScopedData(flaky);
  assert.equal(s.getItem(ANON_ID_KEY), null, '익명 번호는 지워진다');
}

// uid 가 바뀌면(다른 계정) 익명 번호도 새로 받는다.
{
  const s = memoryStore();
  reconcileUserData('a', s);
  s.setItem(ANON_ID_KEY, 'anon-a');
  s.setItem('nextspot_hidden_photos', '{}');
  reconcileUserData('a', s);
  assert.equal(s.getItem(ANON_ID_KEY), 'anon-a', '같은 uid 면 그대로');
  reconcileUserData('b', s);
  assert.equal(s.getItem(ANON_ID_KEY), null);
  assert.equal(s.getItem('nextspot_hidden_photos'), null);
}

clearUserScopedData(null); // 저장소 없음 — 던지지 않는다

console.log('userData.test OK');
