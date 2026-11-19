// 로컬 네트워크 권한 문구는 개발 빌드에만 둔다(App Store 심사 — 쓰지 않는 권한 문구를 묻지 않게).
// expo-dev-client(개발 런처)가 Info.plist 에 NSLocalNetworkUsageDescription 과 Bonjour 서비스(_expo._tcp)를 넣는다.
// 운영 앱은 같은 네트워크의 기기를 찾지 않으므로, 개발 빌드가 아니면 둘 다 지운다.
//
// 빌드 종류: APP_VARIANT → EAS_BUILD_PROFILE(EAS 빌드가 넣는다) 순서로 읽고, 둘 다 없으면 'development'(로컬 `expo run:ios`)로 본다.
//   APP_VARIANT=production npx expo config --type introspect   → 두 키가 없어야 한다
//   npx expo config --type introspect                          → 개발 런처 문구가 남는다
const { withInfoPlist } = require('expo/config-plugins');

const DEV_BONJOUR_SERVICE = '_expo._tcp';

function resolveVariant(env = process.env) {
  const raw = (env.APP_VARIANT || env.EAS_BUILD_PROFILE || '').trim().toLowerCase();
  return raw || 'development';
}

function isDevelopmentVariant(env = process.env) {
  return resolveVariant(env) === 'development';
}

/** Info.plist 객체에서 개발 런처가 넣은 로컬 네트워크 항목을 지운다(제자리 수정). */
function stripDevLocalNetwork(plist) {
  delete plist.NSLocalNetworkUsageDescription;
  if (Array.isArray(plist.NSBonjourServices)) {
    const rest = plist.NSBonjourServices.filter((s) => s !== DEV_BONJOUR_SERVICE);
    if (rest.length > 0) plist.NSBonjourServices = rest;
    else delete plist.NSBonjourServices;
  }
  return plist;
}

function withDevOnlyLocalNetwork(config) {
  if (isDevelopmentVariant()) return config;
  return withInfoPlist(config, (cfg) => {
    stripDevLocalNetwork(cfg.modResults);
    return cfg;
  });
}

module.exports = withDevOnlyLocalNetwork;
module.exports.resolveVariant = resolveVariant;
module.exports.stripDevLocalNetwork = stripDevLocalNetwork;
