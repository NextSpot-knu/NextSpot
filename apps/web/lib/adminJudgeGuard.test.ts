import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JUDGE_ACCOUNTS } from './judgeAccounts';

// 심사용 관리자 계정(openapi@gmail.com)의 막힌 관제 쓰기 — 서버와 웹이 같은 약속을 하는지.
//
// 서버(apps/api/app/routers/admin.py)는 전체 설정 저장과 장소 삭제만 403 으로 막고 이유를 detail 에 싣는다.
// 관제 화면은 403 이면 그 detail 을 그대로 보인다(lib/admin-api.ts adminApiForbiddenDetail — 배선은
// adminCopy.test.ts 가 본다). 그래서 문장의 정본은 서버 상수 하나이고, 여기서는 그 상수가 e2e 가 기대하는
// 문장(admin-judge-guard·admin-dashboard-first-screen)과 같은지, 막는 계정이 로그인 화면이 안내하는 계정인지 본다.

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(WEB, '..', '..');

const adminRouter = readFileSync(join(REPO, 'apps', 'api', 'app', 'routers', 'admin.py'), 'utf8');
const serverDetail = (name: string): string => {
  const m = adminRouter.match(new RegExp(`^${name}\\s*=\\s*"([^"]+)"`, 'm'));
  assert.ok(m, `admin.py 에 ${name} 가 없다`);
  return m[1];
};
assert.equal(serverDetail('_JUDGE_SETTINGS_DETAIL'), '심사용 계정에서는 전체 설정을 바꿀 수 없어요.', '설정 저장 거부 문장이 e2e 기대와 다르다');
assert.equal(serverDetail('_JUDGE_DELETE_DETAIL'), '심사용 계정에서는 장소를 삭제할 수 없어요.', '장소 삭제 거부 문장이 e2e 기대와 다르다');

// 서버가 막는 계정이 로그인 화면이 안내하는 관제 계정과 같아야 한다 — 다르면 엉뚱한 계정이 막힌다.
const authz = readFileSync(join(REPO, 'apps', 'api', 'app', 'core', 'authz.py'), 'utf8');
const judgeEmail = authz.match(/^JUDGE_ADMIN_EMAIL\s*=\s*"([^"]+)"/m);
assert.ok(judgeEmail, 'authz.py 에 JUDGE_ADMIN_EMAIL 이 없다');
assert.equal(judgeEmail[1], JUDGE_ACCOUNTS.admin, '서버가 막는 심사 계정이 웹 안내 계정과 다르다');

console.log('adminJudgeGuard.test.ts ✓');
