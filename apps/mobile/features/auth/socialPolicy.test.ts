// iOS 에 소셜 로그인 경로가 없어야 한다(App Store 4.8 — 계획 §7.2 M3) + OAuth 시작·교환 지점이 하나씩만 있어야 한다.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isIdentityLinkingAllowed,
  isSocialLoginAllowed,
  KAKAO_LOGIN_ENABLED,
  socialProvidersFor,
} from './socialPolicy';

// ── 규칙 ────────────────────────────────────────────────────────────────
assert.deepEqual(socialProvidersFor('ios'), [], 'iOS: 소셜 버튼 없음');
assert.deepEqual(socialProvidersFor('android'), ['google'], '안드로이드: 구글만');
assert.deepEqual(socialProvidersFor('web'), []);
assert.deepEqual(socialProvidersFor('macos'), []);
assert.equal(KAKAO_LOGIN_ENABLED, false, '카카오는 비즈 앱 전환 전까지 숨긴다');
// 카카오를 켜면(비즈 앱 전환 뒤) 웹과 같은 순서 — 카카오(노랑) 다음 구글. iOS·웹 빌드는 여전히 없음(G1-23, D5 ①).
assert.deepEqual(socialProvidersFor('android', true), ['kakao', 'google']);
assert.deepEqual(socialProvidersFor('ios', true), []);
assert.deepEqual(socialProvidersFor('web', true), []);
assert.equal(isSocialLoginAllowed('ios', 'google'), false);
assert.equal(isSocialLoginAllowed('ios', 'kakao'), false);
assert.equal(isSocialLoginAllowed('android', 'google'), true);
assert.equal(isSocialLoginAllowed('android', 'kakao'), false);
assert.equal(isIdentityLinkingAllowed('ios'), false, 'iOS: 계정 연결 없음');
assert.equal(isIdentityLinkingAllowed('android'), false, 'v1: 계정 연결 없음');

// ── 소스 검사 ───────────────────────────────────────────────────────────
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DIRS = ['app', 'components', 'features', 'lib'];

function walk(dir: string, out: string[] = []): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

const files = DIRS.flatMap((d) => walk(join(ROOT, d)));
const rel = (f: string) => relative(ROOT, f).split('\\').join('/');
// 주석은 빼고 본다(설명 글의 'linkIdentity(…)' 를 호출로 세지 않게). 'nextspot://' 같은 문자열은 ':' 뒤라 남는다.
const code = (f: string) =>
  readFileSync(f, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
const using = (re: RegExp) => files.filter((f) => re.test(code(f))).map(rel).sort();

assert.ok(files.length > 10, '앱 소스를 찾았다');
// 계정 연결(linkIdentity)은 앱 어디에도 없다.
assert.deepEqual(using(/\blinkIdentity\s*\(/), [], 'linkIdentity 호출 금지(iOS 4.8 · v1 범위)');
// OAuth 시작은 oauthSession.ts 한 곳 — 그리고 그 파일은 Platform.OS 로 규칙을 다시 확인한다.
assert.deepEqual(using(/\bsignInWithOAuth\s*\(/), ['features/auth/oauthSession.ts']);
const session = readFileSync(join(ROOT, 'features/auth/oauthSession.ts'), 'utf8');
assert.match(session, /if \(!isSocialLoginAllowed\(Platform\.OS, provider\)\) return \{ status: 'blocked' \};/);
// code 교환은 callbackFlow.ts 한 곳(계획 §7.2 — 교환 주인 하나).
assert.deepEqual(using(/\bexchangeCodeForSession\s*\(/), ['features/auth/callbackFlow.ts']);
// 토큰을 딥링크에서 직접 세션으로 넣는 implicit 경로도 없다.
assert.deepEqual(using(/\bsetSession\s*\(/), []);
// 소셜 로그인을 여는 곳은 로그인 화면·마이페이지 계정 연결(안드로이드 구글)·콜백 흐름뿐이다. 모두 같은 입구를 거쳐
// 입구가 Platform.OS 규칙을 다시 본다. 로그인 화면은 버튼 목록을 규칙 함수로만 만든다.
assert.deepEqual(using(/\brunOAuthSession\s*\(/), [
  'app/login.tsx', 'features/auth/callbackFlow.ts', 'features/auth/oauthSession.ts', 'features/mypage/actions.ts',
]);
const login = readFileSync(join(ROOT, 'app/login.tsx'), 'utf8');
assert.match(login, /const providers = socialProvidersFor\(Platform\.OS\);/);
assert.match(login, /providers\.length > 0 && \(/, '소셜 영역은 목록이 비면 그리지 않는다');
assert.doesNotMatch(login, /handleOAuth\('(google|kakao)'\)/, '공급자를 직접 적은 버튼 금지');
// 카카오·구글 문구 키는 PROVIDER_LABEL_KEY 를 통해서만(직접 버튼 금지)
assert.equal((login.match(/auth\.continue(Google|Kakao)/g) ?? []).length, 2);

console.log('socialPolicy.test OK');
