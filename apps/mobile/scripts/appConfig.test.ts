// app.config.ts 를 가짜 환경 변수로 직접 평가해, 지도 키가 android.config 에만 들어가고
// 공개 설정에 남는 extra 에는 불리언 표시만 남는지 확인한다(키 값이 번들·OTA 매니페스트로 새지 않게).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ConfigContext, ExpoConfig } from 'expo/config';

import appConfig from '../app.config';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const appJson = JSON.parse(readFileSync(join(ROOT, 'app.json'), 'utf8')) as { expo: ExpoConfig };
const FAKE_KEY = 'FAKE-test-maps-key-0123456789';

function evaluate(env: string | undefined): ExpoConfig {
  const saved = process.env.GOOGLE_MAPS_ANDROID_API_KEY;
  if (env === undefined) delete process.env.GOOGLE_MAPS_ANDROID_API_KEY;
  else process.env.GOOGLE_MAPS_ANDROID_API_KEY = env;
  try {
    const base = structuredClone(appJson.expo);
    return appConfig({ config: base, projectRoot: ROOT, staticConfigPath: null, packageJsonPath: null } as ConfigContext);
  } finally {
    if (saved === undefined) delete process.env.GOOGLE_MAPS_ANDROID_API_KEY;
    else process.env.GOOGLE_MAPS_ANDROID_API_KEY = saved;
  }
}

const baseExtraKeys = Object.keys(appJson.expo.extra ?? {}).sort();

// 키가 있으면 — 네이티브 매니페스트용 android.config 에 키, extra 엔 true 만.
{
  const out = evaluate(`  ${FAKE_KEY}  `);
  assert.equal(out.android?.config?.googleMaps?.apiKey, FAKE_KEY, '앞뒤 공백을 걷은 키가 android.config 에 들어간다');
  assert.equal(out.extra?.googleMapsConfigured, true);
  assert.deepEqual(Object.keys(out.extra ?? {}).sort(), [...baseExtraKeys, 'googleMapsConfigured'].sort(), 'extra 에 새로 생긴 건 표시 하나뿐');
  assert.ok(!JSON.stringify(out.extra).includes(FAKE_KEY), 'extra 어디에도 키 값이 없다');
  // android.config 를 빼면(= Expo 공개 설정이 하는 일) 남은 어디에도 키가 없다.
  const { config: _stripped, ...androidPublic } = out.android ?? {};
  assert.ok(!JSON.stringify({ ...out, android: androidPublic }).includes(FAKE_KEY), '공개 설정에 키가 새지 않는다');
  // app.json 의 기존 extra(eas.projectId 등)는 그대로.
  assert.deepEqual(out.extra?.eas, appJson.expo.extra?.eas);
}

// 키가 없거나 빈 값이면 — 키도 없고 표시는 false.
for (const env of [undefined, '', '   ']) {
  const out = evaluate(env);
  assert.equal(out.android?.config?.googleMaps, undefined, `env=${JSON.stringify(env)}`);
  assert.equal(out.extra?.googleMapsConfigured, false, `env=${JSON.stringify(env)}`);
}

console.log('OK appConfig');
