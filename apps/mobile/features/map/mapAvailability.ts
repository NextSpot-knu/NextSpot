// 안드로이드에서 구글 지도를 열어도 되는지 — 순수 판정(테스트용으로 NextSpotMap 에서 떼어 냈다).
//
// 왜 extra 인가: Expo 는 단독 실행 빌드(preview·production, Metro 없음)에 넣는 공개 설정에서 android.config·ios.config 를
// 지운다(@expo/config getConfig 의 isPublicConfig). 그래서 Constants.expoConfig.android.config.googleMaps.apiKey 는
// 개발 빌드(Metro 가 전체 설정을 준다)에서만 보이고 배포 빌드에선 늘 비어 지도 대신 안내 판이 떴다.
// app.config.ts 가 키가 있을 때 extra.googleMapsConfigured = true(불리언만, 키 값은 절대 넣지 않는다)를 남기고,
// extra 는 공개 설정에 그대로 남으므로 여기서 그것을 읽는다.

/** app.config.ts 가 extra 에 남기는 표시 이름. */
export const GOOGLE_MAPS_CONFIGURED_EXTRA = 'googleMapsConfigured';

/**
 * 지도를 그려도 되는가. iOS(애플 지도)·웹은 키가 필요 없다. 안드로이드는 키 없이 MapView 를 열면 앱이 죽으므로
 * ("API key not found") 빌드가 키를 넣었다고 표시했을 때만 참이다.
 */
export function isMapAvailable(platform: string, extra: unknown): boolean {
  if (platform !== 'android') return true;
  if (!extra || typeof extra !== 'object') return false;
  return (extra as Record<string, unknown>)[GOOGLE_MAPS_CONFIGURED_EXTRA] === true;
}
