// 약한 영업 근거 등급 채우기(fill_weaker_tiers, P1-4)를 어디서 청하는가 — 화면이 '영업시간을 모르는 곳' 을 다루는
// 종류(음식점·카페)만. 그 카드는 '출발 전에 카카오맵에서 영업시간을 먼저 보여 드려요' 를 달고 길안내 전에 영업시간을 먼저
// 확인시킨다. '영업시간 미확인' 칩은 어느 화면에도 그리지 않으므로(계획 A4) 관광지·문화시설을 채우면 미확인 카드가 확인된
// 카드 뒤에 아무 표시 없이 섞인다(라운드 3 검증).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fillsWeakerTiersFor } from './api-client';

assert.equal(fillsWeakerTiersFor(['restaurant']), true);
assert.equal(fillsWeakerTiersFor(['cafe', 'restaurant']), true);
assert.equal(fillsWeakerTiersFor(['attraction']), false, '관광지는 미확인 영업을 알리고 확인할 길이 없다');
assert.equal(fillsWeakerTiersFor(['culture']), false);
assert.equal(fillsWeakerTiersFor(['cafe', 'culture']), false, '한 종류라도 다루지 못하면 채우지 않는다');
assert.equal(fillsWeakerTiersFor([]), false, '종류를 정하지 않은 요청은 채우지 않는다');

// 채운 음식점·카페 카드는 대안 화면에서도 지도 카드와 같은 안내를 단다 — 예전에는 아무 표시 없이 확인된 곳 뒤에 섞였다.
const WEB = process.cwd();
const explore = readFileSync(join(WEB, 'app/explore/recommend/page.tsx'), 'utf8');
assert.match(
  explore,
  /needsHoursCheck\(rec\)[\s\S]{0,800}?card\.checkHoursKakaoHint/,
  '대안 화면이 영업시간을 모르는 음식점·카페에 안내를 달지 않는다',
);
const card = readFileSync(join(WEB, 'components/RecommendationCard.tsx'), 'utf8');
assert.match(card, /needsHoursConfirmation[\s\S]{0,300}?card\.checkHoursKakaoHint/, '지도 카드의 안내가 사라졌다 — 두 화면이 같은 말을 해야 한다');

console.log('api-client tier fill tests passed');
