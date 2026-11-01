// 지도 기능의 공개 입구 — 화면은 '~/features/map' 만 import 한다(react-native-maps 직접 import 금지).
export { NextSpotMap, DEFAULT_INITIAL_REGION, type NextSpotMapProps } from './NextSpotMap';
export { MapSmoke } from './MapSmoke';
export * from './types';
export {
  COURSE_FIT_MIN_LEVEL,
  COURSE_FIT_PADDING,
  DEFAULT_KAKAO_LEVEL,
  fitPaddingForInsets,
  fitRegion,
  isInRegion,
  kakaoLevelOf,
  kakaoLevelRounded,
  projectToView,
  regionCenteredInBand,
  regionForKakaoLevel,
} from './geometry';
export {
  declutterPins,
  groupSameBuilding,
  markerLimit,
  PIN_GAP_PX,
  SAME_BUILDING_MAX_M,
  type DeclutterItem,
  type PinCluster,
  type Viewport,
} from './declutter';
export { MAP_COLORS } from './pins';
