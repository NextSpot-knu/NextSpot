import assert from 'node:assert/strict';

import { splitLeadingEmoji } from './leadingEmoji';

assert.deepEqual(splitLeadingEmoji('📍 취향·이동시간 맞춤 추천'), { emoji: '📍', rest: '취향·이동시간 맞춤 추천' });
assert.deepEqual(splitLeadingEmoji('🏛️ 경상북도 경주'), { emoji: '🏛️', rest: '경상북도 경주' });
assert.deepEqual(splitLeadingEmoji('🎟️ Partner coupons'), { emoji: '🎟️', rest: 'Partner coupons' });
assert.deepEqual(splitLeadingEmoji('이모지 없음'), { emoji: null, rest: '이모지 없음' });
assert.deepEqual(splitLeadingEmoji('Plain text'), { emoji: null, rest: 'Plain text' });
assert.deepEqual(splitLeadingEmoji('📍'), { emoji: null, rest: '📍' });
assert.deepEqual(splitLeadingEmoji('(1) 안내'), { emoji: null, rest: '(1) 안내' });
console.log('leadingEmoji.test OK');
