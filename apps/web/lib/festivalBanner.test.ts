import assert from 'node:assert/strict';
import { festivalBannerModel, festivalDateLabel, festivalShortDate, festivalTriggerVisible } from './festivalBanner';

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

// ── 언어별 날짜: ko 는 'MM.DD', 그 밖은 그 언어의 월·일('until 10.24' 는 영어 독자가 날짜로 못 읽는다) ──
assert.equal(festivalDateLabel('2026-10-24', 'ko'), '10.24');
assert.equal(festivalDateLabel('2026-10-24', 'en'), 'Oct 24');
assert.equal(festivalDateLabel('2026-10-24', 'ja'), '10月24日');
assert.equal(festivalDateLabel('2026-10-24', 'zh'), '10月24日');
// 하루 밀리지 않는다(시간대와 무관하게 UTC 로 읽고 쓴다).
assert.equal(festivalDateLabel('2026-01-01', 'en'), 'Jan 1');
assert.equal(festivalDateLabel('2026-12-31', 'en'), 'Dec 31');
// 형식이 깨진 값은 지어내지 않는다.
assert.equal(festivalDateLabel('20261024', 'en'), '20261024');
assert.equal(festivalDateLabel('', 'ja'), '');

// ── 어느 모양이 서는가: 응답이 없으면 아무것도, 칩은 1건 이상(예정만 있어도), 배너·한 줄은 진행 중일 때만 ──
for (const variant of ['chip', 'banner', 'compact'] as const) {
  assert.equal(festivalTriggerVisible(variant, null), false, `${variant}: 응답 없음 → 숨김`);
  assert.equal(festivalTriggerVisible(variant, []), false, `${variant}: 0건 → 숨김('행사가 없어요' 빈 상태를 세우지 않는다)`);
  assert.equal(festivalTriggerVisible(variant, [ongoing('EX펌킨나잇')]), true, `${variant}: 진행 중 → 선다`);
}
assert.equal(festivalTriggerVisible('chip', [upcoming('국화 축제')]), true, '칩: 예정만 있어도 선다(패널이 예정 축제를 보여 준다)');
assert.equal(festivalTriggerVisible('banner', [upcoming('국화 축제')]), false);
assert.equal(festivalTriggerVisible('compact', [upcoming('국화 축제')]), false);

console.log('festivalBanner tests passed');
