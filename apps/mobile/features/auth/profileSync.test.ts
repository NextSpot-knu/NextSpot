import assert from 'node:assert/strict';

import { readProviderMeta, resolveProfileSync } from './profileSync';

// 웹 oauthFlow.resolveProfileSync 와 같은 규칙
assert.deepEqual(
  resolveProfileSync({ name: '오윤성', avatar: null }, { nickname: '윤성1', avatar_url: null, nickname_source: 'provider' }),
  { nickname: '오윤성', nickname_source: 'provider' },
);
assert.deepEqual(
  resolveProfileSync({ name: '오윤성', avatar: null }, { nickname: '내이름', avatar_url: null, nickname_source: 'user' }),
  {},
);
assert.deepEqual(resolveProfileSync({ name: 'a', avatar: 'u' }, null), { nickname: 'a', nickname_source: 'provider', avatar_url: 'u' });
assert.deepEqual(resolveProfileSync({ name: 'a', avatar: 'u' }, { nickname: 'a', avatar_url: 'u', nickname_source: null }), {});
assert.deepEqual(readProviderMeta({ full_name: ' 이름 ', picture: 'p' }), { name: '이름', avatar: 'p' });
assert.deepEqual(readProviderMeta({ name: 'n', avatar_url: 'a', picture: 'p' }), { name: 'n', avatar: 'a' });
assert.deepEqual(readProviderMeta({ full_name: 3, name: '' }), { name: null, avatar: null });
assert.deepEqual(readProviderMeta(undefined), { name: null, avatar: null });

console.log('profileSync.test OK');
