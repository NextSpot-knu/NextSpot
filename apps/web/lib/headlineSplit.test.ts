// 대기 보드 머리줄의 값 덩어리 — 중국어·일본어는 공백 없이도 '약 N분' 만 묶는다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { splitHeadlineValue } from './headlineSplit';

const WEB = process.cwd();

// zh: 띄어쓰기 없는 원문 그대로(예전에는 정규식이 공백에 기대 '预计等待 约{n}分钟' 처럼 중국어에 공백을 넣었다).
assert.deepEqual(splitHeadlineValue('预计等待约12分钟'), ['预计等待', '约12分钟', '']);
// ja: '約' 부터 단위까지.
assert.deepEqual(splitHeadlineValue('予想待ち時間 約12分'), ['予想待ち時間 ', '約12分', '']);
// en: 숫자 + ' min' 을 한 덩어리로.
assert.deepEqual(splitHeadlineValue('About 12 min wait'), ['About ', '12 min', ' wait']);
// 쌍점 뒤 등급은 통째로.
assert.deepEqual(splitHeadlineValue('推定混雑: 普通'), ['推定混雑: ', '普通', '']);
assert.deepEqual(splitHeadlineValue('估算拥挤度：普通'), ['估算拥挤度：', '普通', '']);
assert.deepEqual(splitHeadlineValue('Est. crowd: Moderate'), ['Est. crowd: ', 'Moderate', '']);
// 걷는 시간 — 숫자부터 단위까지.
assert.deepEqual(splitHeadlineValue('步行3分钟'), ['步行', '3分钟', '']);
// 묶을 값이 없으면 null(그대로 그린다).
assert.equal(splitHeadlineValue('无需等待'), null);
assert.equal(splitHeadlineValue('Label: '), null);

// 중국어 대기 문구에는 공백이 없다 — 조판용 공백을 문구에 넣지 않는다.
const zh = JSON.parse(readFileSync(join(WEB, 'lib/i18n/messages/zh.json'), 'utf8')) as { wait: { minutes: string } };
assert.doesNotMatch(zh.wait.minutes, /\s/, `zh wait.minutes 에 공백: ${zh.wait.minutes}`);

// 화면이 이 함수를 거친다(같은 판정을 page 에 다시 두지 않는다).
const page = readFileSync(join(WEB, 'app/waiting/page.tsx'), 'utf8');
assert.match(page, /splitHeadlineValue\(text\)/, '대기 보드 머리줄이 splitHeadlineValue 를 쓰지 않는다');

console.log('headlineSplit: ok');
