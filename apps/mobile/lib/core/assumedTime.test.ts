// 가정 시간 — 웹 assumedAtIsoForPreset 과 같은 ISO 인지, 프리셋 표가 웹 소스와 같은지, 저장·구독이 도는지.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ASSUMED_TIME_PRESETS,
  ASSUMED_TIME_STORAGE_KEY,
  assumedAtIsoForPreset,
  assumedPresetLabelKey,
  getStoredAssumedPreset,
  setStoredAssumedPreset,
  subscribeAssumedPreset,
} from './assumedTime';

const here = dirname(fileURLToPath(import.meta.url));

// 1) 프리셋 표 — 웹 소스(apps/web/lib/api-client.ts)에서 id·labelKey·dow·hour 를 읽어 대조한다.
const webSrc = readFileSync(resolve(here, '../../../web/lib/api-client.ts'), 'utf8');
const block = webSrc.slice(webSrc.indexOf('export const ASSUMED_TIME_PRESETS'), webSrc.indexOf('const KST_OFFSET_MS'));
const webRows = [...block.matchAll(/\{ id: "([^"]+)", labelKey: "([^"]+)", dow: (null|\d+), hour: (null|\d+) \}/g)].map((m) => ({
  id: m[1],
  labelKey: m[2],
  dow: m[3] === 'null' ? null : Number(m[3]),
  hour: m[4] === 'null' ? null : Number(m[4]),
}));
assert.equal(webRows.length, 5, '웹 프리셋 5개를 읽어야 한다');
assert.deepEqual(ASSUMED_TIME_PRESETS, webRows, '앱 프리셋 표가 웹과 다르다');

// 2) now·미상 = null
assert.equal(assumedAtIsoForPreset('now'), null);
assert.equal(assumedAtIsoForPreset('nope'), null);

// 3) 고정 시각 — 2026-11-11(수) 03:00 UTC = KST 12:00(수). 평일 12:00 은 같은 시각이면 지난 것이라 다음 주.
const wedNoonKst = Date.UTC(2026, 10, 11, 3, 0, 0);
assert.equal(assumedAtIsoForPreset('weekday_noon', wedNoonKst), '2026-11-18T03:00:00.000Z');
assert.equal(assumedAtIsoForPreset('weekday_noon', wedNoonKst - 1), '2026-11-11T03:00:00.000Z');
assert.equal(assumedAtIsoForPreset('fri_evening', wedNoonKst), '2026-11-13T09:00:00.000Z'); // 금 18:00 KST
assert.equal(assumedAtIsoForPreset('sat_afternoon', wedNoonKst), '2026-11-14T05:00:00.000Z'); // 토 14:00 KST
assert.equal(assumedAtIsoForPreset('sun_morning', wedNoonKst), '2026-11-15T02:00:00.000Z'); // 일 11:00 KST

// 4) KST 날짜 경계 — UTC 로는 화요일 16:00 이지만 KST 는 수요일 01:00. 평일 12:00 은 그날(수) 12:00 KST.
const tueUtcLate = Date.UTC(2026, 10, 10, 16, 0, 0);
assert.equal(assumedAtIsoForPreset('weekday_noon', tueUtcLate), '2026-11-11T03:00:00.000Z');

// 5) 모든 프리셋: 항상 미래 · 7일 이내 · KST 요일·시각이 맞다(여러 시작점).
for (let day = 0; day < 14; day++) {
  for (const hour of [0, 3, 9, 15, 23]) {
    const now = Date.UTC(2026, 10, 1 + day, hour, 17, 0);
    for (const p of ASSUMED_TIME_PRESETS) {
      if (p.dow === null) continue;
      const iso = assumedAtIsoForPreset(p.id, now);
      assert.ok(iso, `${p.id} 는 ISO 여야 한다`);
      const at = new Date(iso).getTime();
      assert.ok(at > now && at <= now + 7 * 86_400_000, `${p.id} 는 미래 7일 안이어야 한다`);
      const kst = new Date(at + 9 * 3_600_000);
      assert.equal(kst.getUTCDay(), p.dow);
      assert.equal(kst.getUTCHours(), p.hour);
      assert.equal(kst.getUTCMinutes(), 0);
    }
  }
}

// 6) 라벨 키
assert.equal(assumedPresetLabelKey('fri_evening'), 'timeSim.friEve');
assert.equal(assumedPresetLabelKey('nope'), 'timeSim.now');

// 7) 저장·구독 — localStorage 대역
const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
  setItem: (k: string, v: string) => void mem.set(k, v),
};
assert.equal(getStoredAssumedPreset(), 'now');
let calls = 0;
const off = subscribeAssumedPreset(() => void calls++);
setStoredAssumedPreset('sat_afternoon');
assert.equal(mem.get(ASSUMED_TIME_STORAGE_KEY), 'sat_afternoon');
assert.equal(getStoredAssumedPreset(), 'sat_afternoon');
assert.equal(calls, 1);
setStoredAssumedPreset('garbage');
assert.equal(getStoredAssumedPreset(), 'now');
assert.equal(calls, 2);
mem.set(ASSUMED_TIME_STORAGE_KEY, 'garbage');
assert.equal(getStoredAssumedPreset(), 'now');
off();
setStoredAssumedPreset('sun_morning');
assert.equal(calls, 2, '해제한 구독자는 부르지 않는다');

// 8) 저장소가 던져도 이번 실행 동안은 값이 선다
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};
setStoredAssumedPreset('fri_evening');
assert.equal(getStoredAssumedPreset(), 'fri_evening');

console.log('assumedTime ok');
