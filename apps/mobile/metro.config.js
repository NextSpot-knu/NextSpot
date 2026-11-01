// 앱은 루트 npm 작업공간 밖의 독립 패키지다(docs/MOBILE_APP_PLAN.md §5.1).
// 웹 lib 의 순수 모듈은 복사하지 않고 그대로 읽는다(§5.2). 웹 쪽 의존 폐포에는 shared-types 말고
// 패키지 import 가 없다(scripts/check-shared-imports.mjs 가 막는다) — 그래서 루트 node_modules 의
// 다른 사본(예: react 두 벌)을 집을 일이 없다. 깨끗한 설치(CI·EAS)에서도 shared-types 가
// 풀리게 앱 node_modules 를 탐색 경로에 더한다.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

const projectRoot = __dirname;
const webRoot = path.resolve(projectRoot, '../web');
const sharedTypes = path.resolve(projectRoot, '../../packages/shared-types');

const config = getDefaultConfig(projectRoot);
config.watchFolders = [path.join(webRoot, 'lib'), sharedTypes];
config.resolver.nodeModulesPaths = [path.join(projectRoot, 'node_modules')];

const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // `@/…` 는 웹 코드의 별칭(apps/web 기준)이다. 앱 자기 코드는 `~/…` 를 쓴다.
  if (moduleName.startsWith('@/')) {
    return context.resolveRequest(context, path.join(webRoot, moduleName.slice(2)), platform);
  }
  if (moduleName.startsWith('~/')) {
    return context.resolveRequest(context, path.join(projectRoot, moduleName.slice(2)), platform);
  }
  return (upstream ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = withNativeWind(config, { input: './global.css' });
