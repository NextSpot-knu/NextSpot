import assert from 'node:assert/strict';
import { matchesTravelContext, type TravelContext } from './travelContext';

const origin = { lat: 35.84, lng: 129.21 };
const distance = (_lat1: number, _lng1: number, lat2: number, _lng2: number) => lat2;
const base = { id: 'place', type: 'culture', latitude: 500, longitude: 0, features: {} };
const context = (overrides: Partial<TravelContext>): TravelContext => ({
  categories: [], requiredAttributes: [], excludeVisited: false, visitedFacilityIds: [], ...overrides,
});

assert.equal(matchesTravelContext(base, context({ maxWalkMinutes: 10 }), origin, distance), true);
assert.equal(matchesTravelContext({ ...base, latitude: 700 }, context({ maxWalkMinutes: 10 }), origin, distance), false);
assert.equal(matchesTravelContext(base, context({ excludeVisited: true, visitedFacilityIds: ['place'] }), origin, distance), false);
assert.equal(matchesTravelContext({ ...base, features: { indoor: true } }, context({ requiredAttributes: ['indoor'] }), origin, distance), true);
assert.equal(matchesTravelContext({ ...base, features: { accessible: true } }, context({ requiredAttributes: ['accessible'] }), origin, distance), false);
assert.equal(matchesTravelContext({ ...base, features: { accessible_verified: true } }, context({ requiredAttributes: ['accessible'] }), origin, distance), true);
assert.equal(matchesTravelContext({ ...base, barrierFree: true }, context({ requiredAttributes: ['accessible'] }), origin, distance), true);

console.log('PASS travel context deterministic fallback eligibility');
