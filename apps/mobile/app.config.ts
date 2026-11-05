// app.json 위에 빌드 때만 정해지는 값을 얹는다.
// 안드로이드 Google Maps 키 — 저장소에 두지 않고 빌드 환경 변수(GOOGLE_MAPS_ANDROID_API_KEY, EAS 환경 변수 또는 로컬 셸)로 넣는다.
// 키는 매니페스트에 들어가 앱 안에서 보이는 값이므로 Google Cloud 에서 패키지명 + 서명 SHA-1 로 반드시 제한한다(계획 §8.1).
// 키가 없는 빌드는 지도 자리에 안내 판을 그린다(NextSpotMap) — 구글 지도는 키 없이 열면 앱이 죽는다.
import type { ConfigContext, ExpoConfig } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => {
  const key = process.env.GOOGLE_MAPS_ANDROID_API_KEY?.trim();
  return {
    ...config,
    android: {
      ...config.android,
      config: { ...config.android?.config, ...(key ? { googleMaps: { apiKey: key } } : {}) },
    },
  } as ExpoConfig;
};
