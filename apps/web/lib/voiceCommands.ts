import type { PlaceCategory, TravelContext } from './travelContext';

export type VoiceAppCommand =
  | { name: 'set_facility_type'; args: { facilityType: PlaceCategory } }
  | { name: 'set_indoor_mode'; args: { enabled: boolean } }
  | { name: 'set_max_walk_minutes'; args: { maxWalkMinutes: 5 | 10 | 20 | null } }
  | { name: 'open_waiting_board'; args: Record<string, never> };

export interface VoiceCommandTransition {
  facilityType: PlaceCategory;
  context: TravelContext;
  navigation?: '/waiting';
}

export function buildVoiceCommandTransition(
  command: VoiceAppCommand,
  currentType: PlaceCategory,
  currentContext: TravelContext,
): VoiceCommandTransition {
  if (command.name === 'open_waiting_board') {
    return { facilityType: currentType, context: currentContext, navigation: '/waiting' };
  }

  let facilityType = currentType;
  let context = { ...currentContext };
  if (command.name === 'set_facility_type') {
    facilityType = command.args.facilityType;
    context = { ...context, categories: [facilityType] };
  } else if (command.name === 'set_indoor_mode') {
    const requiredAttributes = command.args.enabled
      ? [...new Set([...context.requiredAttributes, 'indoor' as const])]
      : context.requiredAttributes.filter((attribute) => attribute !== 'indoor');
    // 비/실내 요청에서 음식점·카페·문화시설은 유지한다. 실외 관광지만 문화시설로 전환한다.
    facilityType = command.args.enabled && currentType === 'attraction' ? 'culture' : currentType;
    context = { ...context, categories: [facilityType], requiredAttributes };
  } else {
    context = {
      ...context,
      categories: [facilityType],
      maxWalkMinutes: command.args.maxWalkMinutes ?? undefined,
    };
  }
  return { facilityType, context };
}
