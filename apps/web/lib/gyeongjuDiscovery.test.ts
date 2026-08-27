import assert from 'node:assert/strict';
import { DISCOVERY_THEMES, findDiscoveryAnchor, getDiscoveryTheme } from './gyeongjuDiscovery';
import { DISCOVERY_MESSAGES } from './i18n/discovery-messages';

const silla = getDiscoveryTheme('silla_core');
assert.equal(
  findDiscoveryAnchor([{ id: '1', name: '대릉원(천마총)' }], silla)?.id,
  '1',
);

// 이름 일부가 같아도 다른 지점·업소를 유명 기준점으로 확정하지 않는다.
assert.equal(findDiscoveryAnchor([{ id: '2', name: '대릉원 카페' }], silla), null);

// 동일 정규화 이름의 중복은 좌표를 임의 선택하지 않고 다음 안전한 별칭을 찾는다.
assert.equal(findDiscoveryAnchor([
  { id: 'a', name: '동궁과 월지' },
  { id: 'b', name: '경주 동궁과 월지' },
], getDiscoveryTheme('night_heritage'))?.id, 'a');

assert.equal(DISCOVERY_THEMES.length, 5);
assert.ok(DISCOVERY_THEMES.every((theme) => theme.anchorAliases.length > 0));
assert.ok(DISCOVERY_THEMES.every((theme) => theme.preferenceIntent.length > 0));

const koKeys = Object.keys(DISCOVERY_MESSAGES.ko).sort();
for (const locale of ['en', 'ja', 'zh'] as const) {
  assert.deepEqual(Object.keys(DISCOVERY_MESSAGES[locale]).sort(), koKeys);
  for (const key of koKeys) {
    const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(
      placeholders(DISCOVERY_MESSAGES[locale][key]),
      placeholders(DISCOVERY_MESSAGES.ko[key]),
      `${locale} placeholder mismatch: ${key}`,
    );
  }
}

console.log('gyeongjuDiscovery tests passed');
