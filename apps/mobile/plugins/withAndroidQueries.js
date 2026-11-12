// 안드로이드 11+ 패키지 가시성 — 카카오맵 앱(kakaomap://)과 전화(tel:)를 canOpenURL 로 확인하려면
// AndroidManifest <queries> 에 선언해야 한다(없으면 늘 '설치 안 됨'으로 보여 웹으로만 열린다).
const { withAndroidManifest } = require('expo/config-plugins');

const INTENTS = [
  { action: 'android.intent.action.VIEW', scheme: 'kakaomap' },
  { action: 'android.intent.action.DIAL', scheme: 'tel' },
];

module.exports = function withAndroidQueries(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest.queries = manifest.queries ?? [{}];
    const queries = manifest.queries[0];
    queries.intent = queries.intent ?? [];
    for (const { action, scheme } of INTENTS) {
      const exists = queries.intent.some(
        (i) => i.action?.[0]?.$?.['android:name'] === action && i.data?.[0]?.$?.['android:scheme'] === scheme,
      );
      if (!exists) {
        queries.intent.push({ action: [{ $: { 'android:name': action } }], data: [{ $: { 'android:scheme': scheme } }] });
      }
    }
    return cfg;
  });
};
