import assert from 'node:assert/strict';

import { toHttpsImageUrl, toHttpsImageUrls } from './images';

// TourAPI firstimage·firstimage2 모양
assert.equal(
  toHttpsImageUrl('http://tong.visitkorea.or.kr/cms/resource/45/2678645_image2_1.jpg'),
  'https://tong.visitkorea.or.kr/cms/resource/45/2678645_image2_1.jpg',
);
assert.equal(
  toHttpsImageUrl('https://tong.visitkorea.or.kr/cms/resource/45/2678645_image3_1.jpg'),
  'https://tong.visitkorea.or.kr/cms/resource/45/2678645_image3_1.jpg',
);
assert.equal(
  toHttpsImageUrl('  HTTP://tong.visitkorea.or.kr/cms/resource/01/a.JPG  '),
  'https://tong.visitkorea.or.kr/cms/resource/01/a.JPG',
);
// TourAPI 는 사진이 없으면 빈 문자열을 준다
assert.equal(toHttpsImageUrl(''), null);
assert.equal(toHttpsImageUrl('   '), null);
assert.equal(toHttpsImageUrl(null), null);
assert.equal(toHttpsImageUrl(undefined), null);
// 스킴 생략·카카오 CDN
assert.equal(toHttpsImageUrl('//t1.daumcdn.net/local/kakaomapPhoto/review/abc.jpg'), 'https://t1.daumcdn.net/local/kakaomapPhoto/review/abc.jpg');
assert.equal(toHttpsImageUrl('http://t1.daumcdn.net/cfile/x?original'), 'https://t1.daumcdn.net/cfile/x?original');
// 쿼리·한글 경로는 건드리지 않는다
assert.equal(toHttpsImageUrl('http://example.kr/사진.jpg?w=300&h=200'), 'https://example.kr/사진.jpg?w=300&h=200');
// 막는 것
assert.equal(toHttpsImageUrl('file:///etc/passwd'), null);
assert.equal(toHttpsImageUrl('javascript:alert(1)'), null);
assert.equal(toHttpsImageUrl('/images/a.jpg'), null);
assert.equal(toHttpsImageUrl('ftp://x/y.jpg'), null);
// data:image 는 그대로
assert.equal(toHttpsImageUrl('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');

assert.deepEqual(
  toHttpsImageUrls([
    'http://tong.visitkorea.or.kr/cms/resource/01/a_image2_1.jpg',
    'https://tong.visitkorea.or.kr/cms/resource/01/a_image2_1.jpg',
    '',
    null,
    'https://upload.wikimedia.org/wikipedia/commons/a/ab/X.jpg',
  ]),
  [
    'https://tong.visitkorea.or.kr/cms/resource/01/a_image2_1.jpg',
    'https://upload.wikimedia.org/wikipedia/commons/a/ab/X.jpg',
  ],
);
assert.deepEqual(toHttpsImageUrls(null), []);
