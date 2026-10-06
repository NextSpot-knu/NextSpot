import assert from 'node:assert/strict';
import { festivalBannerModel, festivalShortDate } from './festivalBanner';

// 랜딩·지도의 '지금 경주 축제' 배너는 진행 중인 축제가 있을 때만 선다. 없으면 자리째 숨는다 —
// '진행 중인 행사가 없어요' 같은 빈 상태 문구를 첫 화면에 세우지 않는다(PM 문구 규칙).

const ongoing = (title: string, endDate = '2026-10-24') => ({ title, startDate: '2026-09-24', endDate, isOngoing: true, imageUrl: null });
const upcoming = (title: string) => ({ title, startDate: '2026-11-01', endDate: '2026-11-03', isOngoing: false, imageUrl: null });

// ── 숨는 경우 ─────────────────────────────────────────────────────────────
assert.equal(festivalBannerModel([]), null, '0건 → 배너 없음');
assert.equal(festivalBannerModel(null), null, '응답 없음 → 배너 없음');
assert.equal(festivalBannerModel(undefined), null);
assert.equal(festivalBannerModel([upcoming('국화 축제')]), null, '예정만 있음 → 배너 없음(진행 중일 때만)');

// ── 서는 경우 ─────────────────────────────────────────────────────────────
const one = festivalBannerModel([ongoing('EX펌킨나잇')]);
assert.ok(one);
assert.equal(one.first.title, 'EX펌킨나잇');
assert.equal(one.moreCount, 0);

// 진행 중 두 건 + 예정 한 건 → 첫 진행 중 축제 + '외 1건'(예정은 세지 않는다). 응답 순서를 지킨다.
const many = festivalBannerModel([upcoming('국화 축제'), ongoing('신라문화제', '2026-10-12'), ongoing('EX펌킨나잇')]);
assert.ok(many);
assert.equal(many.first.title, '신라문화제');
assert.equal(many.moreCount, 1);

// ── 날짜 표기: 'YYYY-MM-DD' → 'MM.DD' (관광객 화면은 올해·내년 축제만 다룬다) ────────────────
assert.equal(festivalShortDate('2026-10-24'), '10.24');
assert.equal(festivalShortDate('2026-01-05'), '01.05');
// 형식이 깨진 값은 지어내지 않고 원문 그대로.
assert.equal(festivalShortDate('20261024'), '20261024');
assert.equal(festivalShortDate(''), '');

console.log('festivalBanner tests passed');
