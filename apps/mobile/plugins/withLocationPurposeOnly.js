// 위치는 '앱 사용 중' 만 쓴다(docs/MOBILE_APP_PLAN.md §6.2·§6.3). expo-location 플러그인은 쓰지 않는 목적 문구
// (항상 위치·동작 감지)에도 영어 기본 문구를 넣는다. 옵션을 false 로 주면 지우지만 문서에 없는 동작이라,
// 다른 플러그인이 다시 넣더라도 Info.plist 에서 한 번 더 지운다 — 심사에서 쓰지 않는 권한 문구를 묻지 않게.
const { withInfoPlist } = require('expo/config-plugins');

const UNUSED_PURPOSE_KEYS = [
  'NSLocationAlwaysAndWhenInUseUsageDescription',
  'NSLocationAlwaysUsageDescription',
  'NSMotionUsageDescription',
];

module.exports = function withLocationPurposeOnly(config) {
  return withInfoPlist(config, (cfg) => {
    for (const key of UNUSED_PURPOSE_KEYS) delete cfg.modResults[key];
    return cfg;
  });
};
