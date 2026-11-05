import assert from 'node:assert/strict';

import { DEFAULT_API_URL, resolveEnv } from './env';
import { readDismissedNotice, shouldShowNotice, writeDismissedNotice } from './noticeDismissal';
import { reconcileUserData, USER_SCOPED_KEYS } from './userData';

// ── env ──
{
  const empty = resolveEnv({}, false);
  assert.equal(empty.apiUrl, DEFAULT_API_URL);
  assert.equal(DEFAULT_API_URL, 'https://nextspot-t2ib.onrender.com');
  assert.equal(empty.supabaseConfigured, false);
  assert.equal(empty.usageEventsEnabled, false);

  const set = resolveEnv({ apiUrl: ' http://10.0.2.2:8000/ ', supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'k', usageEvents: '1' }, false);
  assert.equal(set.apiUrl, 'http://10.0.2.2:8000', '끝 슬래시·공백 제거');
  assert.equal(set.supabaseConfigured, true);
  assert.equal(set.usageEventsEnabled, true, '운영 빌드 + 1 이면 켠다');

  assert.equal(resolveEnv({ usageEvents: '1' }, true).usageEventsEnabled, false, '개발 빌드에서는 늘 끈다');
  assert.equal(resolveEnv({ usageEvents: 'true' }, false).usageEventsEnabled, true);
  assert.equal(resolveEnv({ usageEvents: '0' }, false).usageEventsEnabled, false);
}

// 테스트용 메모리 저장소.
function memoryStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    map: m,
  };
}

// ── 공지 닫기 ──
{
  const s = memoryStore();
  assert.equal(readDismissedNotice(s), null);
  assert.equal(shouldShowNotice('', null), false);
  assert.equal(shouldShowNotice('점검 예정', null), true);
  writeDismissedNotice('점검 예정', s);
  assert.equal(shouldShowNotice('점검 예정', readDismissedNotice(s)), false);
  assert.equal(shouldShowNotice('점검 예정!', readDismissedNotice(s)), true, '문구가 바뀌면 다시 보인다');
  assert.equal(readDismissedNotice(null), null);
}

// ── 사용자 데이터 격리 ──
{
  const s = memoryStore();
  reconcileUserData('a', s);
  s.setItem('nextspot_saved_facilities', '[1]');
  s.setItem('nextspot_locale', 'en');
  reconcileUserData('a', s);
  assert.equal(s.getItem('nextspot_saved_facilities'), '[1]', '같은 uid 면 그대로');
  reconcileUserData(null, s);
  assert.equal(s.getItem('nextspot_saved_facilities'), '[1]', '세션 없음은 판단 보류');
  reconcileUserData('b', s);
  assert.equal(s.getItem('nextspot_saved_facilities'), null, 'uid 가 바뀌면 개인 데이터를 지운다');
  assert.equal(s.getItem('nextspot_locale'), 'en', '기기 설정은 남긴다');
  assert.equal(s.getItem('nextspot_last_uid'), 'b');
  assert.ok(USER_SCOPED_KEYS.includes('nextspot_region' as never));
  assert.ok(USER_SCOPED_KEYS.includes('nextspot_saved_pending_deletes' as never), '저장 해제 대기도 사용자 데이터');
}
