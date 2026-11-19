// 저장 장소의 지역 거르기(S3 · lib/savedRegion.ts) — 경주 저장은 경주에서 보이고 내부 지역에서는 빠진다. 반대도 같다.
// node:assert 독립 스크립트. 내부 지역 묶음은 가짜 좌표의 고정물(fixture)이다 — 실제 내부 지역 값과 무관하다.

import assert from 'node:assert/strict';
import type { InternalRegionView } from './api-client';
import { buildInternalPack, GYEONGJU_PACK } from './regionPacks';
import { filterSavedForPack, savedRecordRegion, savedRegionTag } from './savedRegion';

const view: InternalRegionView = {
  id: 'testregion',
  names: { ko: '시험 지역', en: 'Test', ja: 'テスト', zh: '测试' },
  center: { lat: 36.5, lng: 127.5 },
  bounds: { minLat: 36.4, maxLat: 36.6, minLng: 127.4, maxLng: 127.6 },
  presets: [{ id: 'p1', name: '시험 구역', lat: 36.5, lng: 127.5 }],
  addressToken: '시험',
  facilityCount: 3,
  mappedFacilityCount: 3,
  zoneCount: 1,
  latestObservedAt: null,
};
const internal = buildInternalPack(view);
assert.ok(internal, '고정물 묶음을 만들지 못했다');

// 경주 저장 스냅숏(오늘 모양 — region 표시 없음): 황리단길 안 · 경주 지오펜스 밖(불국사 쪽) · 좌표 없는 옛 저장.
const gyeongjuInside = { id: 'g1', name: '경주 카페', latitude: 35.8362, longitude: 129.2095 };
const gyeongjuOutsideFence = { id: 'g2', name: '경주 외곽', latitude: 35.79, longitude: 129.33 };
const legacyNoCoords = { id: 'g3', name: '옛 저장' };
// 내부 지역 저장: 표시가 붙은 것 · 표시 없이 좌표만 내부 지역 안인 것.
const internalTagged = { id: 's1', name: '내부 장소', latitude: 36.5, longitude: 127.5, region: 'testregion' };
const internalUntagged = { id: 's2', name: '내부 옛 저장', latitude: 36.45, longitude: 127.45 };
const list = [gyeongjuInside, internalTagged, gyeongjuOutsideFence, internalUntagged, legacyNoCoords];

// 1) 경주(내부 지역을 모르는 관광객·게스트): 경주 저장은 전부 그대로(지오펜스 밖·좌표 없음 포함), 표시 붙은 내부 저장만 빠진다.
{
  const shown = filterSavedForPack(list, GYEONGJU_PACK).map((b) => b.id);
  // 표시 없는 내부 저장(s2)은 내부 지역을 모르는 기기에서는 가려낼 근거가 없어 경주로 본다(오늘과 같다).
  assert.deepEqual(shown, ['g1', 'g2', 's2', 'g3']);
  assert.ok(!shown.includes('s1'), '표시 붙은 내부 지역 저장이 경주에 보인다');
  // 경주 저장만 있는 목록은 한 건도 바뀌지 않는다(경주 화면 불변).
  const onlyGyeongju = [gyeongjuInside, gyeongjuOutsideFence, legacyNoCoords];
  assert.deepEqual(filterSavedForPack(onlyGyeongju, GYEONGJU_PACK), onlyGyeongju);
  assert.deepEqual(filterSavedForPack(onlyGyeongju), onlyGyeongju, '기본 묶음이 경주가 아니다');
}

// 2) 경주(내부 지역을 아는 개발자): 좌표로도 내부 지역 저장을 뺀다.
{
  const shown = filterSavedForPack(list, GYEONGJU_PACK, [internal!]).map((b) => b.id);
  assert.deepEqual(shown, ['g1', 'g2', 'g3']);
}

// 3) 내부 지역: 그 지역 저장만(표시 · 좌표), 경주 저장은 전부 빠진다.
{
  const shown = filterSavedForPack(list, internal!).map((b) => b.id);
  assert.deepEqual(shown, ['s1', 's2']);
  assert.deepEqual(filterSavedForPack([gyeongjuInside, gyeongjuOutsideFence, legacyNoCoords], internal!), []);
  // 다른 내부 지역의 표시는 이 지역에 보이지 않는다.
  assert.deepEqual(filterSavedForPack([{ ...internalTagged, region: 'otherregion' }], internal!), []);
}

// 4) 지역 판정 · 저장 표시.
{
  assert.equal(savedRecordRegion(gyeongjuInside, [internal!]), 'gyeongju');
  assert.equal(savedRecordRegion(internalUntagged, [internal!]), 'testregion');
  assert.equal(savedRecordRegion(internalUntagged), 'gyeongju', '모르는 내부 지역을 좌표로 지어냈다');
  assert.equal(savedRecordRegion({ latitude: Number.NaN, longitude: 127.5 }, [internal!]), 'gyeongju');
  assert.deepEqual(savedRegionTag(GYEONGJU_PACK), {}, '경주 저장 스냅숏에 표시를 붙였다(오늘 모양이 바뀐다)');
  assert.deepEqual(savedRegionTag(internal!), { region: 'testregion' });
}

console.log('savedRegion tests passed');
