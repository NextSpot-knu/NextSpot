import assert from 'node:assert/strict';

import type { RecommendationResponse } from '~/lib/core/apiClient';

import {
  boardMeasuredLevel,
  buildSector,
  displayWalkingMinutes,
  estimateLevelOf,
  menusOf,
  photoUrlsOf,
  sortRows,
  type BoardRow,
} from './boardData';

const NOW = new Date('2026-11-02T03:00:00.000Z');

function rec(over: Partial<RecommendationResponse['facility']> & { id: string }, wait: number | null, extra: Partial<RecommendationResponse> = {}): RecommendationResponse {
  return {
    recommendationId: `r-${over.id}`,
    facility: { name: over.id, type: 'cafe', latitude: 35.8, longitude: 129.2, capacity: 20, ...over },
    spotScore: 0.8,
    breakdown: { preference: 0.5, waitTime: wait, travelTime: 4.26 },
    distanceM: 300,
    rank: 1,
    totalCandidates: 3,
    scoringMode: 'degraded_rules',
    predictionSource: 'unavailable',
    ...extra,
  } as RecommendationResponse;
}

// 도보 분: 1분 이상 올림, 경로 분이 없으면 직선거리 보정
assert.equal(displayWalkingMinutes(0.2), 1);
assert.equal(displayWalkingMinutes(4.01), 5);
assert.equal(displayWalkingMinutes(null, 667), Math.ceil((667 * 1.18) / 66.67));
assert.equal(displayWalkingMinutes(undefined), 1);

// 대기 짧은 순, 모르면(null) 뒤, 오늘 휴무 확정은 맨 뒤
const base: BoardRow = {
  facilityId: 'x', name: 'x', type: 'cafe', imageUrls: [], summary: null, congestionLevel: null, areaDemandLevel: null,
  areaDemandParkingEvidence: null, areaDemandTourismEvidence: null, arrivalAction: null, recommendedDepartureDelayMinutes: null,
  expectedWait: null, rankingWait: null, baselineWait: null, capacity: null, expectedTravel: 3, closedToday: false, menus: [],
};
const sorted = sortRows([
  { ...base, facilityId: 'unknown', expectedWait: null },
  { ...base, facilityId: 'closed', expectedWait: 0, closedToday: true },
  { ...base, facilityId: 'slow', expectedWait: 20 },
  { ...base, facilityId: 'fast', expectedWait: 5 },
]);
assert.deepEqual(sorted.map((r) => r.facilityId), ['fast', 'slow', 'unknown', 'closed']);

// 섹터: 빈 응답은 null, 대기 null 을 0 으로 바꾸지 않는다
assert.equal(buildSector('cafe', [], 'ko'), null);
const sector = buildSector('cafe', [rec({ id: 'a' }, null), rec({ id: 'b' }, 12)], 'ko');
assert.ok(sector);
assert.deepEqual(sector.rows.map((r) => [r.facilityId, r.expectedWait]), [['b', 12], ['a', null]]);
assert.equal(sector.rows[1].expectedTravel, 4.3);

// 소개: ko 는 원문, 비-ko 는 번역 우선, 없으면 주소
const withI18n = rec({ id: 'c', overview: '원문', address: '주소', features: { overviewI18n: { en: 'English' } } }, 3);
assert.equal(buildSector('cafe', [withI18n], 'ko')!.rows[0].summary, '원문');
assert.equal(buildSector('cafe', [withI18n], 'en')!.rows[0].summary, 'English');
assert.equal(buildSector('cafe', [rec({ id: 'd', address: ' 주소 ' }, 3)], 'ja')!.rows[0].summary, '주소');

// 메뉴: 두 표기·구분자·중복·최대 5개
assert.deepEqual(menusOf({ first_menu: '국밥, 수육', treatMenu: '국밥/순대\n막걸리·전' }), ['국밥', '수육', '순대', '막걸리', '전']);
assert.deepEqual(menusOf(null), []);
assert.equal(menusOf({ firstMenu: 'a,b,c,d,e,f' }).length, 5);

// 사진: https 로, Wikimedia·경주시 사진은 출처 줄이 없어 뺀다, 중복 제거
assert.deepEqual(
  photoUrlsOf({
    imageUrl: 'http://tong.visitkorea.or.kr/a.jpg',
    galleryImages: ['https://tong.visitkorea.or.kr/a.jpg', 'https://upload.wikimedia.org/x.jpg', 'https://www.gyeongju.go.kr/y.jpg', 'https://cdn.example.com/z.jpg'],
  }),
  ['https://tong.visitkorea.or.kr/a.jpg', 'https://cdn.example.com/z.jpg'],
);
assert.deepEqual(photoUrlsOf({ imageUrl: null, galleryImages: null }), []);

// 휴무 확정만 closedToday (restDateRaw 가 없으면 false)
assert.equal(buildSector('cafe', [rec({ id: 'e' }, 1)], 'ko')!.rows[0].closedToday, false);

// 혼잡: 지금 자격이 있는 실측·예측만 센다
const fresh = new Date(NOW.getTime() - 5 * 60 * 1000).toISOString();
assert.equal(boardMeasuredLevel({ congestionLevel: 0.4, congestionSource: 'measured' }, NOW), 0.4);
assert.equal(boardMeasuredLevel({ congestionLevel: 0.4, congestionSource: 'predicted', congestionIsCurrent: false }, NOW), 0.4);
assert.equal(boardMeasuredLevel({ congestionLevel: null }, NOW), null);
// 서버가 '지금이 아니다' → 신선한 추정이 있으면 추정이 이긴다(null), 없으면 24시간 안쪽 관측만
const est = { level: 0.3, source: 'estimated', observedAt: fresh };
const hourAgo = new Date(NOW.getTime() - 3600_000).toISOString();
const old = new Date(NOW.getTime() - 48 * 3600_000).toISOString();
assert.equal(boardMeasuredLevel({ congestionLevel: 0.9, congestionIsCurrent: false, congestionTimestamp: hourAgo, congestionEstimate: est as never }, NOW), null);
assert.equal(boardMeasuredLevel({ congestionLevel: 0.9, congestionIsCurrent: false, congestionTimestamp: hourAgo }, NOW), 0.9);
assert.equal(boardMeasuredLevel({ congestionLevel: 0.9, congestionIsCurrent: false, congestionTimestamp: old }, NOW), null);
assert.equal(boardMeasuredLevel({ congestionLevel: 0.9, congestionIsCurrent: false }, NOW), null);

// 추정 피드: 60분·모양·범위 검증
assert.equal(estimateLevelOf(est, NOW), 0.3);
assert.equal(estimateLevelOf({ ...est, observedAt: hourAgo }, new Date(NOW.getTime() + 3600_000)), null);
assert.equal(estimateLevelOf({ ...est, level: 1.5 }, NOW), null);
assert.equal(estimateLevelOf({ ...est, source: 'measured' }, NOW), null);
assert.equal(estimateLevelOf(null, NOW), null);

console.log('boardData.test.ts ok');
