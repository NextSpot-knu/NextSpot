// 랜딩(app/page.tsx) 배선 가드 — 타입도 화면 테스트도 잡지 못하는 종류의 어긋남을 소스에서 막는다
// (lib/adminDashboardWiring.test.ts 와 같은 방식).
//
// 잠그는 사실:
//   (1) '데스크톱이냐'를 JS 로 판정하는 미디어 쿼리가 Tailwind lg 와 같은 단위(rem)다. px 로 쓰면 브라우저 기본 글자
//       크기가 16px 이 아닐 때(크롬 '글꼴 크게' = 20px → lg 는 1280px) 보이는 배치와 JS 판정이 갈린다 — 폰 배치가
//       보이는데 화면 탭이 안 먹거나, 데스크톱 배치에서 소개 모달이 저절로 열린다(2026-10-07 리뷰).
//   (2) 폰 첫 화면의 출처 줄은 '바로 시작'·축제 배너 바로 아래, 로그인 줄보다 위다 — 맨 아래에 두면 축제가 선 날
//       390×844 첫 화면 밖으로 밀렸다(e2e/landing.spec.ts 가 위치를, 여기서는 순서를 잠근다).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = process.cwd(); // 러너가 cwd 를 apps/web 으로 고정한다
const read = (p: string) => readFileSync(join(WEB, p), 'utf8');
const stripComments = (s: string) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '');

const page = stripComments(read('app/page.tsx'));
const globals = read('app/globals.css');

// ── (1) JS 판정 = Tailwind lg ─────────────────────────────────────────────
const query = /const DESKTOP_QUERY = '([^']+)'/.exec(page)?.[1];
assert.ok(query, 'app/page.tsx 에 DESKTOP_QUERY 가 없다');
// Tailwind v4 기본 lg 는 64rem. 테마에서 바꿨다면 그 값과 같아야 한다.
const lg = /--breakpoint-lg:\s*([^;]+);/.exec(globals)?.[1]?.trim() ?? '64rem';
assert.equal(query, `(min-width: ${lg})`, `DESKTOP_QUERY 는 Tailwind lg(${lg})와 같은 단위·값이어야 한다`);
assert.ok(!/min-width:\s*\d+px/.test(query), 'px 쿼리는 기본 글자 크기가 바뀌면 lg: 와 갈린다');

// ── (2) 폰 첫 화면 순서: 바로 시작 → 축제 배너 → 출처 줄 → 로그인 ─────────────────────────────
const phone = page.slice(0, page.indexOf('lg:block'));
const at = (needle: string) => {
  const index = phone.indexOf(needle);
  assert.ok(index >= 0, `폰 배치에 ${needle} 가 없다`);
  return index;
};
const order = [
  at("t('landing.ctaStart')"),
  at('<FestivalBanner variant="banner"'),
  at("t('landing.dataAttribution')"),
  at("t('landing.ctaLogin')"),
  at("t('nav.merchantShort')"),
];
assert.deepEqual([...order].sort((a, b) => a - b), order, '폰 첫 화면 순서가 바로 시작 → 축제 → 출처 → 로그인 → 콘솔이 아니다');

console.log('landingWiring tests passed');
