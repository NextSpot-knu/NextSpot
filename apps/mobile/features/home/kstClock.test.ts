import assert from 'node:assert/strict';

import { clockLabels, kstFields } from './kstClock';

// 2026-11-10 15:00 UTC = 2026-11-11 00:00 KST(수요일)
const at = new Date(Date.UTC(2026, 10, 10, 15, 0, 0));
assert.deepEqual(kstFields(at), { month: 11, day: 11, weekday: 3, hour: 0, minute: 0 });
const ko = clockLabels(at, 'ko');
assert.ok(ko.date.includes('11월') && ko.date.includes('11일'), ko.date);
assert.ok(ko.time.includes('12:00'), ko.time);
const en = clockLabels(new Date(Date.UTC(2026, 10, 10, 6, 5, 0)), 'en'); // 15:05 KST
assert.ok(en.time.includes('3:05') && en.time.includes('PM'), en.time);
console.log('kstClock ok');
