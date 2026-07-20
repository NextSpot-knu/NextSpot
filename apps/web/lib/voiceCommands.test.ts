import assert from 'node:assert/strict';

import { EMPTY_TRAVEL_CONTEXT } from './travelContext';
import { buildVoiceCommandTransition } from './voiceCommands';

const restaurant = buildVoiceCommandTransition(
  { name: 'set_indoor_mode', args: { enabled: true } },
  'restaurant',
  EMPTY_TRAVEL_CONTEXT,
);
assert.equal(restaurant.facilityType, 'restaurant');
assert.deepEqual(restaurant.context.requiredAttributes, ['indoor']);

const cafe = buildVoiceCommandTransition(
  { name: 'set_indoor_mode', args: { enabled: true } },
  'cafe',
  EMPTY_TRAVEL_CONTEXT,
);
assert.equal(cafe.facilityType, 'cafe');

const attraction = buildVoiceCommandTransition(
  { name: 'set_indoor_mode', args: { enabled: true } },
  'attraction',
  EMPTY_TRAVEL_CONTEXT,
);
assert.equal(attraction.facilityType, 'culture');
assert.deepEqual(attraction.context.categories, ['culture']);

const walk = buildVoiceCommandTransition(
  { name: 'set_max_walk_minutes', args: { maxWalkMinutes: 10 } },
  'restaurant',
  EMPTY_TRAVEL_CONTEXT,
);
assert.equal(walk.context.maxWalkMinutes, 10);

const waiting = buildVoiceCommandTransition(
  { name: 'open_waiting_board', args: {} },
  'restaurant',
  EMPTY_TRAVEL_CONTEXT,
);
assert.equal(waiting.navigation, '/waiting');

console.log('voice command transition tests passed');
