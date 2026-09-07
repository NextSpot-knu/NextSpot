// e2e 가 **정말로** 외부 호출 없이 도는가 — 소스 배선 가드.
//
// 이 가드가 필요한 이유: CI 워크플로가 이 묶음을 "결정적(실계정·GPS·지도 SDK·외부 네트워크
// 없이)" 이라고 적어 두었는데 오랫동안 사실이 아니었다. 앱이 부팅하며 익명 세션을 만들려고
// **프로덕션 Supabase** 로 `POST /auth/v1/signup` 을 보냈고, 그게 늦거나 막히면
// `recommendByType` 이 AuthError 를 던져 화면이 '조건에 맞는 곳 0건' 을 **'장애'** 로 바꿔
// 말했다. 그래서 `empty` 와 `failed` 를 갈라 놓으려고 만든 판정(lib/replanOutcome.ts)이
// 인증 지연 하나에 무너졌고, e2e 가 간헐적으로 깨졌다(2026-09-07 재현·수정).
//
// Playwright 는 이 저장소의 기본 게이트에 없어서(브라우저 설치가 필요하다) 배선이 풀려도
// 한동안 아무도 모른다. 그래서 **소스에서** 확인한다 — 이 파일은 node 러너로 항상 돈다.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const WEB = process.cwd();
const E2E = join(WEB, 'e2e');

const specs = readdirSync(E2E).filter((f) => f.endsWith('.spec.ts'));
assert.ok(specs.length >= 3, `e2e 스펙을 찾지 못했다: ${JSON.stringify(specs)}`);

for (const spec of specs) {
  const src = readFileSync(join(E2E, spec), 'utf8');
  assert.match(
    src,
    /stubExternalServices/,
    `${spec} 가 공용 스텁을 쓰지 않는다 — 이 스펙은 외부(Supabase 인증)로 나갈 수 있다`,
  );
  // 카카오만 막고 인증을 빼먹는 옛 모양으로 되돌아가지 않게 한다.
  assert.doesNotMatch(
    src.replace(/^\s*\/\/.*$/gm, ''),
    /page\.route\('\*\*:\/\/dapi\.kakao\.com/,
    `${spec} 가 지도 SDK 만 따로 막는다 — 공용 스텁(support/stubs.ts)으로 모아야 인증도 함께 막힌다`,
  );
}

// 스텁 자체가 인증 경로를 다루는가.
{
  const stubs = readFileSync(join(E2E, 'support', 'stubs.ts'), 'utf8');
  assert.match(stubs, /auth\/v1/, '공용 스텁이 Supabase 인증 경로를 가로채지 않는다');
  assert.match(stubs, /dapi\.kakao\.com/, '공용 스텁이 지도 SDK 를 가로채지 않는다');
  assert.match(
    stubs,
    /access_token/,
    '인증 스텁이 세션을 돌려주지 않는다 — 빈 응답이면 익명 로그인이 실패한 것과 같다',
  );
}

console.log('e2e determinism guard passed');
