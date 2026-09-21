import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JUDGE_ACCOUNTS, judgeConsoleForNext } from './judgeAccounts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// ── 계정↔역할이 백엔드 시드와 같아야 한다 ─────────────────────────────────────
// 화면이 "관제는 이 계정"이라고 알려준 계정에 실제로 admin 역할이 없으면, 심사위원은
// 안내대로 로그인하고도 '권한 없음'을 본다. 시드 스크립트가 정본이므로 거기서 읽어 대조한다.
const seed = readFileSync(join(REPO, 'apps', 'api', 'scripts', 'seed_judge_accounts.py'), 'utf8');
const seedEmail = (name: string): string => {
  const m = seed.match(new RegExp(`^${name}\\s*=\\s*"([^"]+)"`, 'm'));
  assert.ok(m, `seed_judge_accounts.py 에 ${name} 가 없다`);
  return m[1];
};
assert.equal(JUDGE_ACCOUNTS.merchant, seedEmail('MERCHANT_EMAIL'), '사장님 콘솔 계정이 시드와 다르다');
assert.equal(JUDGE_ACCOUNTS.admin, seedEmail('ADMIN_EMAIL'), '관제 계정이 시드와 다르다');
assert.notEqual(JUDGE_ACCOUNTS.merchant, JUDGE_ACCOUNTS.admin);

// ── next 목적지 → 콘솔 ────────────────────────────────────────────────────────
assert.equal(judgeConsoleForNext('/admin/dashboard'), 'admin');
assert.equal(judgeConsoleForNext('/admin'), 'admin');
assert.equal(judgeConsoleForNext('/admin/dashboard?tab=impact'), 'admin');
assert.equal(judgeConsoleForNext('/merchant'), 'merchant');
assert.equal(judgeConsoleForNext('/merchant/dashboard#sale'), 'merchant');

// 콘솔이 아닌 목적지에서는 특정 계정을 밀지 않는다.
assert.equal(judgeConsoleForNext('/main'), null);
assert.equal(judgeConsoleForNext('/course?s=abc'), null);
assert.equal(judgeConsoleForNext(null), null);
assert.equal(judgeConsoleForNext(undefined), null);
assert.equal(judgeConsoleForNext(''), null);

// 접두사만 같은 경로를 콘솔로 오인하지 않는다.
assert.equal(judgeConsoleForNext('/administrator'), null);
assert.equal(judgeConsoleForNext('/merchants'), null);

console.log('judgeAccounts.test.ts ✓');
