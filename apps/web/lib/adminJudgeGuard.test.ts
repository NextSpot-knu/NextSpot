import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JUDGE_BLOCKED_MESSAGES, judgeBlockedMessage } from './adminJudgeGuard';
import { JUDGE_ACCOUNTS } from './judgeAccounts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(WEB, '..', '..');

// ── 403 이면 이유, 아니면 null(호출부가 기존 '잠시 후 다시' 문구를 그대로 쓴다) ──────────
assert.equal(judgeBlockedMessage(403, 'settings'), '심사용 계정에서는 전체 설정을 바꿀 수 없어요.');
assert.equal(judgeBlockedMessage(403, 'deleteFacility'), '심사용 계정에서는 장소를 삭제할 수 없어요.');
for (const status of [null, 401, 404, 500, 503]) {
  assert.equal(judgeBlockedMessage(status, 'settings'), null, `${status} 는 심사 계정 가드가 아니다`);
  assert.equal(judgeBlockedMessage(status, 'deleteFacility'), null, `${status} 는 심사 계정 가드가 아니다`);
}

// ── 문장·계정이 서버와 같아야 한다 ─────────────────────────────────────────────────
// 서버 detail 이 정본이다(admin-api 가 원문을 화면에 싣지 않으므로 웹이 같은 문장을 들고 있다).
const adminRouter = readFileSync(join(REPO, 'apps', 'api', 'app', 'routers', 'admin.py'), 'utf8');
const serverDetail = (name: string): string => {
  const m = adminRouter.match(new RegExp(`^${name}\\s*=\\s*"([^"]+)"`, 'm'));
  assert.ok(m, `admin.py 에 ${name} 가 없다`);
  return m[1];
};
assert.equal(JUDGE_BLOCKED_MESSAGES.settings, serverDetail('_JUDGE_SETTINGS_DETAIL'), '설정 저장 거부 문장이 서버와 다르다');
assert.equal(JUDGE_BLOCKED_MESSAGES.deleteFacility, serverDetail('_JUDGE_DELETE_DETAIL'), '장소 삭제 거부 문장이 서버와 다르다');

// 서버가 막는 계정이 로그인 화면이 안내하는 관제 계정과 같아야 한다 — 다르면 엉뚱한 계정이 막힌다.
const authz = readFileSync(join(REPO, 'apps', 'api', 'app', 'core', 'authz.py'), 'utf8');
const judgeEmail = authz.match(/^JUDGE_ADMIN_EMAIL\s*=\s*"([^"]+)"/m);
assert.ok(judgeEmail, 'authz.py 에 JUDGE_ADMIN_EMAIL 이 없다');
assert.equal(judgeEmail[1], JUDGE_ACCOUNTS.admin, '서버가 막는 심사 계정이 웹 안내 계정과 다르다');

// ── 두 쓰기의 실패 처리가 이 판정을 거친다(빠지면 심사위원은 될 리 없는 재시도 안내를 본다) ──
const settingsPage = readFileSync(join(WEB, 'app', 'admin', 'settings', 'page.tsx'), 'utf8');
assert.match(settingsPage, /judgeBlockedMessage\(adminApiStatus\(e\), 'settings'\)/, '설정 저장 실패가 심사 계정 403 을 가르지 않는다');
const facilityTable = readFileSync(join(WEB, 'components', 'admin', 'FacilityTable.tsx'), 'utf8');
assert.match(
  facilityTable,
  /judgeBlockedMessage\(adminApiStatus\(err\), 'deleteFacility'\)/,
  '장소 삭제 실패가 심사 계정 403 을 가르지 않는다',
);

console.log('adminJudgeGuard.test.ts ✓');
