// check-shared-imports.mjs 의 판정 함수 — 주석/문자열 구분, 금지 패턴, 플랫폼 변형 해석, WebView 패키지 검사.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bannedPackageProblems, forbiddenIn, resolveFiles, specifiers, stripComments } from './check-shared-imports.mjs';

// 문자열 안의 // 는 주석이 아니다 — 뒤의 코드가 지워지지 않아야 한다.
{
  const code = "const u = 'https://x.y'; window.foo = 1;";
  assert.equal(stripComments(code), code);
  assert.deepEqual(forbiddenIn(code).map(([line]) => line), [1]);
  assert.equal(stripComments('a // window.x').trim(), 'a');
  assert.equal(stripComments('a /* window.x\n */ b').split('\n').length, 2, '줄 수 유지');
  assert.deepEqual(forbiddenIn('/* window.x */ ok'), []);
  assert.deepEqual(specifiers("import x from 'https://a';\n// import y from 'nope'"), ['https://a']);
}

// 금지 패턴
{
  const hit = (line: string) => forbiddenIn(line).length > 0;
  assert.ok(hit('const k = process.env.NEXT_PUBLIC_API_URL;'));
  assert.ok(hit('location.href = "/"'));
  assert.ok(hit('if (x) location.reload()'));
  assert.ok(hit('self.postMessage(1)'));
  assert.ok(hit("window['x']"));
  assert.ok(hit('globalThis.window?.foo'));
  assert.ok(hit('navigator.geolocation'));
  assert.ok(!hit('route.location.lat'), 'obj.location 은 괜찮다');
  assert.ok(!hit('this.selfTest()'));
  assert.ok(!hit('const myself = 1; myself.x'));
  assert.ok(!hit('process.env.EXPO_PUBLIC_API_URL'));
}

// 플랫폼 변형 해석(Metro 처럼) — 있는 변형을 모두 돌려준다
{
  const dir = mkdtempSync(join(tmpdir(), 'check-shared-'));
  try {
    writeFileSync(join(dir, 'a.ts'), '');
    writeFileSync(join(dir, 'b.native.ts'), '');
    writeFileSync(join(dir, 'c.android.ts'), '');
    writeFileSync(join(dir, 'c.ios.ts'), '');
    writeFileSync(join(dir, 'c.ts'), '');
    mkdirSync(join(dir, 'd'));
    writeFileSync(join(dir, 'd', 'index.ts'), '');
    assert.deepEqual(resolveFiles(join(dir, 'a')), [join(dir, 'a.ts')]);
    assert.deepEqual(resolveFiles(join(dir, 'b')), [join(dir, 'b.native.ts')]);
    assert.deepEqual(resolveFiles(join(dir, 'c')), [join(dir, 'c.android.ts'), join(dir, 'c.ios.ts'), join(dir, 'c.ts')]);
    assert.deepEqual(resolveFiles(join(dir, 'd')), [join(dir, 'd', 'index.ts')]);
    assert.deepEqual(resolveFiles(join(dir, 'zzz')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// WebView 패키지
{
  const optionalPeer = {
    packages: {
      '': { dependencies: { expo: '1' } },
      'node_modules/expo': { peerDependencies: { 'react-native-webview': '*' }, peerDependenciesMeta: { 'react-native-webview': { optional: true } } },
    },
  };
  assert.deepEqual(bannedPackageProblems({ dependencies: { expo: '1' } }, optionalPeer), [], '선택 peer 로 이름만 있으면 통과');
  assert.equal(bannedPackageProblems({ dependencies: { 'react-native-webview': '13' } }, optionalPeer).length, 1);
  assert.equal(
    bannedPackageProblems({}, { packages: { 'node_modules/some-lib/node_modules/react-native-webview': {} } }).length,
    1,
    '다른 패키지가 끌고 와 설치된 것도 잡는다',
  );
  assert.deepEqual(bannedPackageProblems(null, null), []);
}

console.log('ok check-shared-imports');
