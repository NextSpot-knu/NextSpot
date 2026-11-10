import assert from 'node:assert/strict';

import { telHref } from '@/lib/phoneLink';
import { kakaoDrivingHandoff, kakaoPlaceHandoff, kakaoWalkingHandoff, normalizeKakaoPlaceId } from './kakaoLinks';

const dest = { name: '첨성대', latitude: 35.8347, longitude: 129.2190 };
const origin = { latitude: 35.8380, longitude: 129.2110 };
const encName = encodeURIComponent('첨성대');

// 도보 — 웹 주소는 웹 navigation.ts 와 같다.
const walkWeb = `https://map.kakao.com/link/map/${encName},35.8347,129.219`;
assert.deepEqual(kakaoWalkingHandoff(dest), { app: 'kakaomap://look?p=35.8347,129.219', web: walkWeb });
assert.deepEqual(kakaoWalkingHandoff(dest, origin), {
  app: 'kakaomap://route?sp=35.838,129.211&ep=35.8347,129.219&by=foot',
  web: walkWeb,
});
assert.equal(kakaoWalkingHandoff({ ...dest, kakaoPlaceId: '8193853' }).app, 'kakaomap://place?id=8193853');
assert.equal(kakaoWalkingHandoff({ ...dest, kakaoPlaceId: 'abc' }).app, 'kakaomap://look?p=35.8347,129.219');
assert.equal(kakaoWalkingHandoff({ ...dest, latitude: Number.NaN }).app, null, '좌표가 깨지면 앱 스킴 없이');
assert.equal(kakaoWalkingHandoff(dest, { latitude: 999, longitude: 0 }).app, 'kakaomap://look?p=35.8347,129.219');

// 이름의 쉼표·슬래시도 웹과 같이 인코딩한다.
assert.equal(
  kakaoWalkingHandoff({ name: 'A, B/C', latitude: 1, longitude: 2 }).web,
  'https://map.kakao.com/link/map/A%2C%20B%2FC,1,2',
);

// 차 — 출발지가 있을 때만 앱 스킴.
const driveWeb = `https://map.kakao.com/link/to/${encName},35.8347,129.219`;
assert.deepEqual(kakaoDrivingHandoff(dest), { app: null, web: driveWeb });
assert.deepEqual(kakaoDrivingHandoff(dest, origin), {
  app: 'kakaomap://route?sp=35.838,129.211&ep=35.8347,129.219&by=car',
  web: driveWeb,
});

// 장소
assert.deepEqual(kakaoPlaceHandoff(8193853), { app: 'kakaomap://place?id=8193853', web: 'https://place.map.kakao.com/8193853' });
assert.equal(kakaoPlaceHandoff('12a'), null);
assert.equal(kakaoPlaceHandoff(null), null);
assert.equal(normalizeKakaoPlaceId(' 42 '), '42');

// 전화 — 웹 순수 모듈을 그대로 쓴다.
assert.equal(telHref('054-772-3843~4'), 'tel:0547723843');
assert.equal(telHref(null), null);

// 좌표 없음(옛 저장 북마크) → 이름 검색(웹 saved/page.tsx)
assert.equal(kakaoWalkingHandoff({ name: '향화정', latitude: NaN, longitude: NaN }).web, `https://map.kakao.com/?q=${encodeURIComponent('향화정')}`);
assert.equal(kakaoDrivingHandoff({ name: '향화정', latitude: NaN, longitude: NaN }).web, `https://map.kakao.com/?q=${encodeURIComponent('향화정')}`);
