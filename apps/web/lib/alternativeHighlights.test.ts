import assert from 'node:assert/strict';

import { buildAlternativeHighlights } from './alternativeHighlights';

const base = [
  { id: 'a', rank: 1, spotScore: 91, preferencePercent: 80, travelMinutes: 8 },
  { id: 'b', rank: 2, spotScore: 89, preferencePercent: 70, travelMinutes: 4 },
  { id: 'c', rank: 3, spotScore: 88, preferencePercent: 60, travelMinutes: 10 },
];

{
  const highlights = buildAlternativeHighlights(base);
  assert.equal(highlights.length, 3);
  assert.equal(new Set(highlights.map((item) => item.basis)).size, 3);
  assert.equal(highlights.find((item) => item.id === 'b')?.basis, 'travel');
  assert.equal(highlights.find((item) => item.id === 'b')?.isBest, true);
}

{
  const highlights = buildAlternativeHighlights([
    {
      ...base[0],
      arrivalAction: 'choose_calmer' as const,
      areaDemandDistinguishable: true,
      areaDemandConfidence: 'high' as const,
      areaDemandRank: 1,
      areaDemandComparableCount: 8,
    },
    ...base.slice(1),
  ]);
  assert.equal(highlights[0].basis, 'crowd');
}

{
  const highlights = buildAlternativeHighlights([
    {
      ...base[0],
      arrivalAction: 'choose_calmer' as const,
      areaDemandDistinguishable: false,
      areaDemandConfidence: 'high' as const,
      areaDemandRank: 1,
      areaDemandComparableCount: 8,
    },
    ...base.slice(1),
  ]);
  assert.equal(highlights.some((item) => item.basis === 'crowd'), false);
}

{
  const highlights = buildAlternativeHighlights([
    { ...base[0], travelMinutes: 5.2 },
    { ...base[1], travelMinutes: 5.5 },
    { ...base[2], travelMinutes: 5.7 },
  ]);
  const travel = highlights.find((item) => item.basis === 'travel');
  assert.equal(travel?.isBest, false);
}

console.log('alternative highlight tests passed');
