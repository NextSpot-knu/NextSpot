// 관제 콘솔 문구 가드 — 심사위원이 읽는 관제 화면에 영어 메뉴·내부 용어가 돌아오지 않게 소스에서 막는다
// (렌더 테스트 러너가 없어서 화면 문구는 아무도 검사해 주지 않는다 — adminDashboardWiring.test.ts 와 같은 방식).
//
// 잠그는 사실(2026-10-06 심사 화면 점검):
//   (1) 사이드바 메뉴는 한국어다('Dashboard'·'Simulator'·'(Support)' 가 섞여 있었다). 'SPOT' 은 서비스 고유 용어라 허용.
//   (2) '엔진 검증' 은 심사 기간에 메뉴에서 감춘다(PM 결정 4.14) — 화면은 URL 로 그대로 열린다.
//   (3) 문의·설정·쿠폰·신뢰도·시뮬레이터·대시보드·장소 관리 표에 영어 라벨·개발 용어(W_pref·가드레일·다봉·(CRUD) …)가 없다.
//       시뮬레이터의 혜택 축은 SPOT 인센티브 항 그대로 '혜택·혼잡 분산'(쿠폰 강도 + 혼잡 분산)이고,
//       추천 신뢰도 패널은 검증 관측 수를 아래 격자와 같은 이름('검증·상호확인')으로 부른다.
//   (4) 안전 경보의 두 슬라이더는 같은 0–100 눈금이다(같은 % 가 두 트랙에서 같은 자리에 선다).
//   (5) 서버가 403 으로 쓰기를 거절하면 서버가 준 사유 문장이 그대로 보인다(설정 저장·장소 삭제).
//       설정 폼은 저장돼 있는 값으로 되돌아간다(거절된 값이 남으면 사유 문장이 사라진 뒤 저장된 것처럼 보인다).
//       계정 판정은 서버가 한다 — 화면은 이메일을 보고 미리 막지 않는다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AdminApiError, adminApiForbiddenDetail } from './admin-api';

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
    'components/admin/FacilityTable.tsx',
    'app/admin/dashboard/page.tsx',
  ];
  const FORBIDDEN =
    /\(Support\)|Help & Support|W_pref|W_time|W_inc|다봉|w3 |가드레일|ML 후보|Total:|New:|'NEW'|>NEW<|IN PROGRESS|RESOLVED|\(General\)|Congestion Threshold|\(Red\)|\(Override\)|Preference, Time Cost|\(CRUD\)/;
  for (const file of FILES) {
    const hit = stripComments(read(file)).match(FORBIDDEN);
    assert.equal(hit, null, `${file} 화면 문구에 영어 라벨·개발 용어가 남아 있다: ${hit?.[0]}`);
  }
  // 장소 관리 화면 제목이 메뉴 이름과 같다(메뉴 '장소 관리' → 화면 '관광지 모니터링' 이던 불일치).
  assert.match(read('app/admin/infrastructure/page.tsx'), />장소 관리<\/h2>/, '장소 관리 화면 제목이 메뉴 이름과 다르다');
  // 시뮬레이터 혜택 축 = SPOT 인센티브 항(쿠폰 강도 + 혼잡 분산, score.py W3) — '쿠폰' 만 말하면 이 축의 모의 값
  // (한산 보너스)과도, 서비스의 핵심 가치(혼잡 분산)와도 어긋난다.
  const simulator = stripComments(read('components/admin/SPOTSimulator.tsx'));
  assert.match(simulator, /label="혜택·혼잡 분산"/, "시뮬레이터 혜택 축 이름에 '혼잡 분산' 이 없다");
  assert.doesNotMatch(simulator, /혜택\(쿠폰\)|쿠폰을 건 곳이 앞서/, '시뮬레이터가 혜택 축을 쿠폰만으로 설명한다');
  // 추천 신뢰도 패널 — trusted_observations 는 한 이름(격자의 '검증·상호확인')으로만 부른다.
  // '현장 확인' 이라 부르면 바로 아래 '전체 현장 관측'(다른 숫자)과 짝지어 읽혀 숫자가 안 맞아 보인다.
  const trust = stripComments(read('components/admin/ModelTrustPanel.tsx'));
  assert.match(trust, /검증·상호확인 <strong[^>]*>\{data\.collection\.trusted_observations\}/, '격자의 검증 관측 이름이 바뀌었다 — 아래 문장들과 함께 바꿀 것');
  assert.match(trust, /`검증·상호확인 \$\{remaining\}건이 더 쌓이면/, '학습 관문 문장이 검증 관측을 격자와 다른 이름으로 부른다');
  assert.match(trust, /<span>검증·상호확인 \{trusted\} \/ \{candidateGate\}건/, '학습 관문 진행 막대가 검증 관측을 격자와 다른 이름으로 부른다');
  assert.doesNotMatch(trust, /현장 확인/, "'현장 확인' 은 격자의 '전체 현장 관측' 과 섞여 읽힌다");
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

// ── (5) 서버가 거절한 쓰기는 서버의 사유 문장으로 ─────────────────────────────
{
  const SETTINGS_DETAIL = '심사용 계정에서는 전체 설정을 바꿀 수 없어요.';
  const DELETE_DETAIL = '심사용 계정에서는 장소를 삭제할 수 없어요.';
  const generic = '관제 데이터를 다시 불러오는 중입니다. 잠시 후 자동으로 표시됩니다.';
  assert.equal(adminApiForbiddenDetail(new AdminApiError(generic, 'http', 403, SETTINGS_DETAIL)), SETTINGS_DETAIL);
  assert.equal(adminApiForbiddenDetail(new AdminApiError(generic, 'http', 403, DELETE_DETAIL)), DELETE_DETAIL);
  // 403 이 아니면 원문을 내지 않는다(5xx 원문은 콘솔 전용 — 검수 안 된 서버 문장이 화면에 나가지 않게).
  assert.equal(adminApiForbiddenDetail(new AdminApiError(generic, 'http', 500, '시스템 설정 저장에 실패했습니다.')), null);
  assert.equal(adminApiForbiddenDetail(new AdminApiError(generic, 'http', 403)), null, '사유가 없는 403 은 기존 안내로 물러난다');
  assert.equal(adminApiForbiddenDetail(new AdminApiError(generic, 'timeout')), null);
  assert.equal(adminApiForbiddenDetail(Object.assign(new Error('x'), { status: 403, detail: SETTINGS_DETAIL })), null, '관리자 API 가 아닌 에러의 detail 은 믿지 않는다');
  // 사유 문장은 message 에 섞지 않는다 — message 를 그대로 그리는 다른 화면은 지금처럼 일반 문구만 본다.
  assert.equal(new AdminApiError(generic, 'http', 403, SETTINGS_DETAIL).message, generic);

  const api = stripComments(read('lib/admin-api.ts'));
  assert.match(api, /response\.status,\s*typeof errorData\?\.detail === 'string'/, '관리자 API 가 서버 detail 을 에러에 싣지 않는다');

  const settings = stripComments(read('app/admin/settings/page.tsx'));
  assert.match(settings, /const denied = adminApiForbiddenDetail\(e\);[\s\S]*text: denied \?\? '저장에 실패했습니다/, '설정 저장 실패가 서버의 거절 사유를 보이지 않는다');
  // 거절되면 폼을 저장돼 있는 값(마지막 조회·저장 성공)으로 되돌린다 — 세 값 모두.
  const restore = settings.match(/if \(denied\) \{([\s\S]*?)\}/);
  assert.ok(restore, '설정 저장이 거절돼도 폼이 저장된 값으로 돌아가지 않는다');
  for (const setter of ['setIsMaintenance', 'setNotice', 'setThreshold']) {
    assert.ok(restore[1].includes(`${setter}(storedRef.current.`), `거절 뒤 ${setter} 가 저장된 값으로 돌아가지 않는다`);
  }
  // 저장된 값은 조회 성공과 저장 성공 두 곳에서만 바뀐다(거절·실패에서는 안 바뀐다).
  assert.equal(settings.split('storedRef.current =').length - 1, 2, '저장된 값(storedRef)이 조회·저장 성공 밖에서 바뀐다');
  const table = stripComments(read('components/admin/FacilityTable.tsx'));
  assert.match(table, /toast\.error\(adminApiForbiddenDetail\(err\) \?\? '삭제를/, '장소 삭제 실패가 서버의 거절 사유를 보이지 않는다');
  // 계정 판정은 서버 몫 — 화면이 이메일로 미리 막으면 서버 가드와 갈라진다.
  for (const [name, src] of [['settings/page.tsx', settings], ['FacilityTable.tsx', table]] as const) {
    assert.doesNotMatch(src, /openapi@|JUDGE_ACCOUNTS|judgeAccounts/, `${name} 가 클라이언트에서 계정 이메일로 판정한다`);
  }
}

// ── (7) 장소 관리 — 가짜 발송 없음 · 빈 추이 카드 없음 · '관측 대기' 벽 없음(I72) ─────────────────────────────
{
  const infra = stripComments(read('app/admin/infrastructure/page.tsx'));
  assert.doesNotMatch(infra, /분산 안내 발송|오늘 혼잡도를 수집하는 중입니다/, '장소 관리에 가짜 발송·빈 추이 문구가 남아 있다');
  assert.match(infra, /facilityCongestionFrom\(/, '장소 관리가 관광객 지도와 같은 추정을 쓰지 않는다');
  assert.match(infra, /getCongestionEstimates\(/, '장소 관리가 추정 피드를 받지 않는다');
  assert.match(infra, /staleObservationLine\(/, '오래된 관측이 날짜 없이 현재 상태로 그려진다');
  assert.doesNotMatch(stripComments(read('lib/adminMetricState.ts')), /'관측 대기'/, "'관측 대기' 라벨이 돌아왔다");
}

console.log('adminCopy.test.ts OK');
