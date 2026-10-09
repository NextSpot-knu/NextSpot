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

// 운영 DB 의 실제 이름들(10-09 /infrastructures 실측 — 주변 가게 이름 몇 개 포함)로 다섯 테마가 모두 기준점을 찾는다.
// 예전 별칭은 '대릉원(천마총)' 만 알아 실제 이름 '천마총(대릉원)' 에서 신라 핵심 산책·한옥 카페가 아무 일도 하지 않았다.
{
  const live = ['천마총(대릉원)', '경주 동궁과 월지', '국립경주박물관', '월정교', '경주 첨성대',
    '빽다방 경주대릉원점', '대릉원본가', '스타벅스 경주대릉원점', '샬로우커피 황리단길점']
    .map((name, index) => ({ id: String(index), name }));
  for (const theme of DISCOVERY_THEMES) {
    assert.ok(findDiscoveryAnchor(live, theme), `${theme.id} has no anchor in the live names`);
  }
  assert.equal(findDiscoveryAnchor(live, silla)?.name, '천마총(대릉원)');
}

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
