// 한산 알림 — 두 가지 배선을 소스에서 잠근다.
//
// React 테스트 러너가 없어 훅과 화면을 렌더할 수 없다(merchant/api.test.ts 의 '화면 배선 가드'
// 와 같은 상황·같은 방식). 여기서 막는 것은 둘 다 **초록 게이트를 통과하면서 기능만 죽는** 모양이다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = process.cwd(); // 러너가 cwd 를 apps/web 으로 고정한다
const strip = (s: string) => s.replace(/^\s*\/\/.*$/gm, '');

// --- (1) 알림이 실제로 만들어졌을 때만 '알림 보냄' 깃발을 세운다 --------------
// 세우고 나면 그 장소는 다시 붐볐다가 또 한산해질 때까지 알림 대상에서 빠진다. 그래서
// Notification 생성이 던졌는데도 깃발을 세우면 **그 한산은 사용자에게 영영 전달되지 않는다.**
// 권한이 세션 중 취소되거나 브라우저가 생성을 막으면 생성자는 실제로 던진다.
{
  const src = strip(readFileSync(join(WEB, 'lib/useCongestionAlerts.ts'), 'utf8'));

  assert.match(src, /delivered\s*=\s*true;/, "알림 생성 성공을 기록하지 않는다");
  assert.match(
    src,
    /if\s*\(delivered\)\s*\{[^}]*notified\[place\.id\]\s*=\s*true;/,
    "notified 깃발이 delivered 가드 밖에서 세워진다 — 뜨지 않은 알림이 '보냄' 으로 기록된다",
  );
  // catch 블록이 다시 깃발을 세우지 않는지(가드를 우회하지 않는지) 확인한다.
  const catchBlocks = src.match(/catch\s*\{[^}]*\}/g) ?? [];
  for (const block of catchBlocks) {
    assert.doesNotMatch(block, /notified\[place\.id\]\s*=\s*true/, `catch 안에서 깃발을 세운다: ${block}`);
  }
}

// --- (2) 확인이 실패하는 중이면 토글이 그 사실을 말한다 ----------------------
// 훅은 lastCheckFailed 를 계속 계산하고 있었는데 **읽는 곳이 한 군데도 없었다.** 백엔드가
// 죽어도 토글은 '알림 받는 중' 으로 켜져 있었다 — 그 파일이 스스로 내건 "되지 않는 버튼을
// 켜진 것처럼 보이지 않게" 와 정반대다.
{
  const hook = strip(readFileSync(join(WEB, 'lib/useCongestionAlerts.ts'), 'utf8'));
  const toggle = strip(readFileSync(join(WEB, 'components/CongestionAlertToggle.tsx'), 'utf8'));

  assert.match(hook, /lastCheckFailed/, '훅이 lastCheckFailed 를 더 이상 노출하지 않는다');
  assert.match(hook, /setLastCheckFailed\(false\)/, '성공했을 때 실패 표시를 지우지 않는다 — 한 번 실패하면 영구 경고가 된다');
  assert.match(toggle, /lastCheckFailed\s*\}?\s*=\s*useCongestionAlerts\(\)|lastCheckFailed\s*,/, '토글이 lastCheckFailed 를 구조분해하지 않는다');
  assert.match(toggle, /lastCheckFailed\s*&&/, '토글이 lastCheckFailed 를 조건으로 쓰지 않는다 — 계산만 하고 그리지 않으면 없는 것과 같다');
  assert.match(toggle, /alert\.checkFailed/, '실패 문구 키를 쓰지 않는다');
}

// --- (3) 그 i18n 키가 네 로케일에 모두 있다 ----------------------------------
for (const loc of ['ko', 'en', 'ja', 'zh']) {
  const messages = JSON.parse(readFileSync(join(WEB, `lib/i18n/messages/${loc}.json`), 'utf8'));
  const value = messages?.alert?.checkFailed;
  assert.equal(typeof value, 'string', `${loc}.json 에 alert.checkFailed 가 없다`);
  assert.ok(value.length > 0, `${loc}.json 의 alert.checkFailed 가 비어 있다`);
}

console.log('congestion alert wiring tests passed');
