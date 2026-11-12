import assert from 'node:assert/strict';

import { PLACE_MOTIFS } from '@/lib/placeVisual';

import { EMBLEM, emblemShift } from './placeEmblem';

// 모든 문양이 있고, 경로 명령만 쓰며, 잘못된 숫자가 없다.
for (const motif of PLACE_MOTIFS) {
  const d = EMBLEM[motif];
  assert.ok(d.length > 40, `${motif} 경로가 비었다`);
  assert.match(d, /^M-?\d/, `${motif} 은 M 으로 시작`);
  assert.ok(/^[MAQTHVL0-9.\- ]+$/.test(d), `${motif} 에 허용 밖 문자`);
}

// 웹 PlacePhotoFallback.tsx 와 같은 값(원본 함수를 그대로 복사했으므로 잠가 둔다).
assert.ok(EMBLEM.giwa.startsWith('M-10 82 A10 10 0 0 1 10 82 M10 82 A10 10 0 0 1 30 82'));
assert.ok(EMBLEM.giwa.includes('M0 92 A10 10 0 0 1 20 92'));
assert.ok(EMBLEM.roundel.startsWith('M50 94 A30 30 0 1 0 110 94 A30 30 0 1 0 50 94 M56 94 A24 24'));
assert.equal(EMBLEM.roundel.split(' M').length, 3 + 8);
assert.ok(EMBLEM.pagoda.startsWith('M52 112 V106 H108 V112'));
assert.ok(EMBLEM.pagoda.endsWith('M80 68 V56 M76.5 64 H83.5 M77.5 60 H82.5'));
assert.ok(EMBLEM.wave.startsWith('M-25 80 Q-18.75 73 -12.5 80 T0 80'));
assert.equal(
  EMBLEM.lattice,
  'M56 58 H112 M56 58 V116 M60 62 H112 M60 62 V116 M68 62 V116 M76 62 V116 M84 62 V116 M92 62 V116 M100 62 V116 M108 62 V116 M60 74 H112 M60 86 H112 M60 98 H112 M60 110 H112',
);

// 비낌: phase 0 → -6.0, 0.5 → 0.0, 1 → 6.0.
assert.equal(emblemShift(0), '-6.0');
assert.equal(emblemShift(0.5), '0.0');
assert.equal(emblemShift(1), '6.0');

console.log('placeEmblem.test OK');
