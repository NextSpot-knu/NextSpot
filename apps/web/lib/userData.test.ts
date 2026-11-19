import assert from 'node:assert/strict';

// 로그아웃·계정 전환 시 clearUserScopedData 가 개인 키(저장 해제 대기열 포함)를 지우고 기기 설정은 남기는지 확인.
const store = new Map<string, string>();
const fake = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
};
Object.assign(globalThis, { localStorage: fake, sessionStorage: { ...fake, getItem: () => null, removeItem: () => {}, key: () => null, length: 0 } });

async function main() {
  const { clearUserScopedData } = await import('./userData');
  store.set('nextspot_saved_facilities', '["a"]');
  store.set('nextspot_saved_pending_deletes', '["b"]');
  store.set('nextspot_lang', 'ko'); // 기기 UI 설정 — 보존돼야 한다
  clearUserScopedData();
  assert.equal(store.has('nextspot_saved_facilities'), false);
  assert.equal(store.has('nextspot_saved_pending_deletes'), false, '저장 해제 대기열이 로그아웃 때 남으면 안 된다');
  assert.equal(store.get('nextspot_lang'), 'ko');
  console.log('userData.test OK');
}
main();
