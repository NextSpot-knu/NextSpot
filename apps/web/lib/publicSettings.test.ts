// 운영자 공개 설정 — 파싱·폴백·표시 대상 경로 판정.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_BUSY_THRESHOLD } from './congestionScale';
import {
  FALLBACK_PUBLIC_SETTINGS,
  isTouristPath,
  parsePublicSettings,
} from './publicSettings';

const WEB = process.cwd();

// --- 정상 응답 ----------------------------------------------------------------
{
  const s = parsePublicSettings({ maintenanceMode: true, noticeText: '  오늘 야간 점검  ', congestionThreshold: 60 });
  assert.equal(s.maintenanceMode, true);
  assert.equal(s.noticeText, '오늘 야간 점검', '앞뒤 공백은 다듬는다(공백만 있는 공지 = 공지 없음)');
  assert.equal(s.busyThreshold, 0.6);
}

// --- 조회 실패·미배포(404) 자리 -------------------------------------------------
// ⚠️ 여기가 이 파일의 핵심이다: 조회 실패를 '점검 중' 으로 오해시키면 멀쩡한 서비스가 내려간다.
for (const bad of [undefined, null, 'maintenance', 404, [], NaN]) {
  const s = parsePublicSettings(bad);
  assert.deepEqual(s, FALLBACK_PUBLIC_SETTINGS, `${String(bad)} 는 평소 화면(폴백)이어야 한다`);
  assert.equal(s.maintenanceMode, false);
  assert.equal(s.noticeText, '');
  assert.equal(s.busyThreshold, DEFAULT_BUSY_THRESHOLD);
}

// --- 점검 모드는 명시적 true 일 때만 --------------------------------------------
// 'false' 문자열·1·null 이 점검을 켜면 안 된다(응답 형식이 흔들리는 창을 가정).
for (const truthy of ['true', 'false', 1, 'on', {}]) {
  assert.equal(
    parsePublicSettings({ maintenanceMode: truthy }).maintenanceMode,
    false,
    `maintenanceMode=${String(truthy)} 는 점검 모드가 아니다`,
  );
}
assert.equal(parsePublicSettings({ maintenanceMode: true }).maintenanceMode, true);

// --- 필드별 독립 판정 -----------------------------------------------------------
// 공지가 이상하다고 혼잡 경계까지 버리지 않는다(그 반대도 마찬가지).
{
  const s = parsePublicSettings({ noticeText: 42, congestionThreshold: 80 });
  assert.equal(s.noticeText, '');
  assert.equal(s.busyThreshold, 0.8);
}
{
  const s = parsePublicSettings({ noticeText: '공지', congestionThreshold: 'high' });
  assert.equal(s.noticeText, '공지');
  assert.equal(s.busyThreshold, DEFAULT_BUSY_THRESHOLD);
}

// --- 장문 공지는 잘라 화면을 덮지 않게 -------------------------------------------
assert.equal(parsePublicSettings({ noticeText: 'ㄱ'.repeat(500) }).noticeText.length, 300);

// --- 표시 대상 경로 --------------------------------------------------------------
// 관리자·상인 콘솔은 점검을 **푸는** 쪽이라 점검 화면에 갇히면 안 된다.
assert.equal(isTouristPath('/main'), true);
assert.equal(isTouristPath('/'), true);
assert.equal(isTouristPath('/course'), true);
assert.equal(isTouristPath('/admin'), false);
assert.equal(isTouristPath('/admin/infrastructure'), false);
assert.equal(isTouristPath('/merchant'), false);
assert.equal(isTouristPath('/dev'), false);
assert.equal(isTouristPath('/administrator'), true, '접두사 문자열 일치로 남의 경로를 삼키지 않는다');
assert.equal(isTouristPath(null), false, '경로를 모르면 아무것도 그리지 않는다');
assert.equal(isTouristPath(''), false);

// --- 화면 배선 가드 ----------------------------------------------------------------
{
  const provider = readFileSync(join(WEB, 'components/shell/PublicSettingsProvider.tsx'), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.match(provider, /parsePublicSettings\(data\)/, '프로바이더가 parsePublicSettings 를 쓰지 않는다');
  assert.match(
    provider,
    /isTouristPath\(pathname\)/,
    '프로바이더가 콘솔 경로를 걸러내지 않는다 — 관리자가 점검 화면에 갇힌다',
  );
  // 실패를 상태로 옮기는 catch 가 있으면 실패가 화면을 바꿀 수 있다. 조용히 폴백이어야 한다.
  assert.doesNotMatch(provider, /catch[\s\S]{0,80}setSettings/, '조회 실패가 설정 상태를 건드린다');

  const layout = readFileSync(join(WEB, 'app/layout.tsx'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.match(layout, /<PublicSettingsProvider>/, '레이아웃이 PublicSettingsProvider 를 마운트하지 않는다');
}

console.log('publicSettings tests passed');
