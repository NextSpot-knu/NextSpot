// 분산 코스 '추천 이유' — 서버가 시간 분산 효과를 말했을 때만 화면 언어로 그 이유를 붙인다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stopCalmerOnArrival } from './courseStopReason';

const WEB = process.cwd();

// 서버 문장(courses.py _build_stop_reason)의 두 모양.
assert.equal(
  stopCalmerOnArrival('2번째 코스 경주 첨성대: 약 48분 뒤 도착하면 예상 혼잡도 42%(여유) 수준이에요. 지금보다 약 30%p 여유로워질 시간대예요.'),
  true,
);
assert.equal(stopCalmerOnArrival('2번째 코스 경주 첨성대: 약 48분 뒤 도착하면 예상 혼잡도 42%(여유) 수준이에요.'), false);
assert.equal(stopCalmerOnArrival('1번째 고요한 찻집: 약 6분 후 도착합니다. 취향·실제 이동시간·혜택 기준 추천입니다.'), false);
assert.equal(stopCalmerOnArrival(''), false);
assert.equal(stopCalmerOnArrival(null), false);

// 서버가 그 구절을 아직 같은 말로 쓰는가 — 서버 문장을 바꾸면 이 신호가 조용히 꺼진다.
const courses = readFileSync(join(WEB, '../api/app/routers/courses.py'), 'utf8');
assert.match(courses, /여유로워질 시간대예요/, '서버 사유 문장이 바뀌었다 — lib/courseStopReason.ts 의 신호를 맞출 것');

// 화면의 이유는 순서·이름·시각을 되풀이하지 않는다(칩이 이미 말한다) — 왜 골랐는지를 말한다.
for (const locale of ['ko', 'en', 'ja', 'zh']) {
  const m = JSON.parse(readFileSync(join(WEB, `lib/i18n/messages/${locale}.json`), 'utf8')) as { course: Record<string, string> };
  assert.equal(typeof m.course.stopWhy, 'string', `${locale}: course.stopWhy`);
  assert.equal(typeof m.course.stopCalmer, 'string', `${locale}: course.stopCalmer`);
  assert.doesNotMatch(m.course.stopWhy, /\{(order|name|time)\}/, `${locale}: 이유가 순서·이름·시각을 되풀이한다`);
  assert.doesNotMatch(m.course.stopCalmer, /%/, `${locale}: 붐빔을 %로 말한다`);
}

console.log('courseStopReason: ok');
