// 관제 콘솔 문구 가드 — 심사위원이 읽는 관제 화면에 영어 메뉴·내부 용어가 돌아오지 않게 소스에서 막는다
// (렌더 테스트 러너가 없어서 화면 문구는 아무도 검사해 주지 않는다 — adminDashboardWiring.test.ts 와 같은 방식).
//
// 잠그는 사실(2026-10-06 심사 화면 점검):
//   (1) 사이드바 메뉴는 한국어다('Dashboard'·'Simulator'·'(Support)' 가 섞여 있었다). 'SPOT' 은 서비스 고유 용어라 허용.
//   (2) '엔진 검증' 은 심사 기간에 메뉴에서 감춘다(PM 결정 4.14) — 화면은 URL 로 그대로 열린다.
//   (3) 문의·설정·쿠폰·신뢰도·시뮬레이터 화면에 영어 라벨·개발 용어(W_pref·가드레일·다봉 …)가 없다.
//   (4) 안전 경보의 두 슬라이더는 같은 0–100 눈금이다(같은 % 가 두 트랙에서 같은 자리에 선다).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = process.cwd(); // 러너가 cwd 를 apps/web 으로 고정한다
const read = (p: string) => readFileSync(join(WEB, p), 'utf8');
// 주석은 걷어낸다 — 옛 문구를 인용한 주석이 가드를 깨지 않게, 그리고 주석이 '배선' 의 증거가 되지 않게.
const stripComments = (s: string) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '');

// ── (1)(2) 사이드바 ───────────────────────────────────────────────────────────
{
  const sidebar = stripComments(read('components/AdminSidebar.tsx'));
  const names = [...sidebar.matchAll(/\{ name: '([^']+)', path: '([^']+)'/g)].map((m) => ({ name: m[1], path: m[2] }));
  assert.ok(names.length >= 9, `사이드바 메뉴를 찾지 못했다(${names.length}개) — 정규식이 낡았는지 확인할 것`);
  for (const { name } of names) {
    assert.doesNotMatch(name.replace(/SPOT/g, ''), /[A-Za-z]/, `사이드바 메뉴 '${name}' 에 영어가 남아 있다`);
  }
  const byPath = Object.fromEntries(names.map(({ name, path }) => [path, name]));
  assert.equal(byPath['/admin/dashboard'], '관제 대시보드', '대시보드 메뉴 이름이 기능설명서 용어(관제 대시보드)가 아니다');
  assert.equal(byPath['/admin/simulator'], 'SPOT 시뮬레이터');
  assert.equal(byPath['/admin/support'], '문의 관리');

  // 엔진 검증은 정의는 남기고(심사 뒤 되돌리기 쉽게) 메뉴에서만 거른다.
  assert.match(sidebar, /HIDDEN_FROM_MENU = new Set<string>\(\[[^\]]*'\/admin\/engine-validation'[^\]]*\]\)/, "'엔진 검증' 이 심사 기간 숨김 목록에 없다");
  assert.match(sidebar, /\]\.filter\(\(item\) => !HIDDEN_FROM_MENU\.has\(item\.path\)\)/, '메뉴가 숨김 목록으로 걸러지지 않는다');
}

// ── (3) 화면 문구 ─────────────────────────────────────────────────────────────
{
  const FILES = [
    'app/admin/support/page.tsx',
    'app/admin/settings/page.tsx',
    'app/admin/safety/page.tsx',
    'app/admin/infrastructure/page.tsx',
    'app/admin/simulator/page.tsx',
    'components/admin/CouponPolicyPanel.tsx',
    'components/admin/ModelTrustPanel.tsx',
    'components/admin/SPOTSimulator.tsx',
  ];
  const FORBIDDEN =
    /\(Support\)|Help & Support|W_pref|W_time|W_inc|다봉|w3 |가드레일|ML 후보|Total:|New:|'NEW'|>NEW<|IN PROGRESS|RESOLVED|\(General\)|Congestion Threshold|\(Red\)|\(Override\)|Preference, Time Cost/;
  for (const file of FILES) {
    const hit = stripComments(read(file)).match(FORBIDDEN);
    assert.equal(hit, null, `${file} 화면 문구에 영어 라벨·개발 용어가 남아 있다: ${hit?.[0]}`);
  }
  // 장소 관리 화면 제목이 메뉴 이름과 같다(메뉴 '장소 관리' → 화면 '관광지 모니터링' 이던 불일치).
  assert.match(read('app/admin/infrastructure/page.tsx'), />장소 관리<\/h2>/, '장소 관리 화면 제목이 메뉴 이름과 다르다');
  // 설정 부제가 없는 기능(추천 알고리즘 파라미터)을 약속하지 않는다.
  assert.doesNotMatch(read('app/admin/settings/page.tsx'), /AI 추천 알고리즘의 세부 파라미터/, '설정 부제가 화면에 없는 컨트롤을 약속한다');
}

// ── (4) 안전 경보 슬라이더 눈금 ───────────────────────────────────────────────
{
  const safety = stripComments(read('app/admin/safety/page.tsx'));
  const ranges = [...safety.matchAll(/type="range"\s+min=\{([^}]+)\}\s+max=\{([^}]+)\}/g)].map((m) => [m[1], m[2]]);
  assert.equal(ranges.length, 2, `안전 경보 슬라이더를 찾지 못했다(${ranges.length}개)`);
  for (const [min, max] of ranges) {
    assert.deepEqual([min, max], ['0', '100'], `슬라이더 눈금이 상대 값을 따라 움직인다(min=${min}, max=${max})`);
  }
  // 같은 눈금에서도 주의 < 경보 는 유지된다(경보 ≥ 1, 주의 ≤ 99).
  assert.match(safety, /Math\.max\(1, raw\)/, '경보 임계값 하한(1%)이 없다 — 주의가 설 자리가 없어진다');
  assert.match(safety, /Math\.min\(99, raw\)/, '주의 임계값 상한(99%)이 없다');
}

console.log('adminCopy.test.ts OK');
