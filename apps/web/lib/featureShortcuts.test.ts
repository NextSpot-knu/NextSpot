import assert from 'node:assert/strict';
import { FEATURE_SHORTCUT_KEYS, MAIN_FOCUS_PATHS, featureShortcuts } from './featureShortcuts';
import { ADMIN_CONSOLE_PATH, ADMIN_DEMO_PATH, MERCHANT_CONSOLE_PATH, MERCHANT_DEMO_PATH } from './consoleLinks';
import { parseAccount, type Account, type AccountRole } from './accountRoles';
import { keysToCamel } from './caseTransform';

// 랜딩·서비스 소개의 '이렇게 써 보세요' 다섯 줄은 기능설명서 §5 의 핵심 기능 1~5 순서 그대로다.
// 심사위원은 문서를 옆에 두고 1번부터 눌러 본다 — 순서가 어긋나면 문서와 화면이 다른 말을 한다.

function acct(role: AccountRole, isAnonymous = false): Account {
  return parseAccount(
    keysToCamel({ id: 'u1', role, is_anonymous: isAnonymous, nickname: null, owned_facilities: [], pending_verification: false }),
  );
}

// ── 순서와 개수 ───────────────────────────────────────────────────────────
assert.deepEqual([...FEATURE_SHORTCUT_KEYS], ['forecast', 'card', 'live', 'voice', 'console']);
assert.deepEqual(featureShortcuts(null).map((row) => row.key), ['forecast', 'card', 'live', 'voice', 'console']);

// ── 1~4번은 /main 으로 가는 링크 한 개 — ?focus 계약(core2 레인이 /main 마운트 때 한 번 읽는다) ──
assert.equal(MAIN_FOCUS_PATHS.forecast, '/main?focus=forecast');
assert.equal(MAIN_FOCUS_PATHS.card, '/main');
assert.equal(MAIN_FOCUS_PATHS.live, '/main?focus=live');
assert.equal(MAIN_FOCUS_PATHS.voice, '/main?focus=voice');
const guestRows = featureShortcuts(null);
assert.deepEqual(
  guestRows.slice(0, 4).map((row) => row.href),
  ['/main?focus=forecast', '/main', '/main?focus=live', '/main?focus=voice'],
);
for (const row of guestRows.slice(0, 4)) assert.equal(row.consoles, undefined, `${row.key}: 콘솔 버튼이 붙으면 안 된다`);

// ── 5번은 링크가 아니라 버튼 두 개(사장님 콘솔 · 관제 대시보드) — 목적지는 역할로 갈린다 ─────────
const fifth = (account: Account | null) => featureShortcuts(account)[4];
assert.equal(fifth(null).href, undefined);
// 계정을 아직 모를 때·게스트·관광객 → 둘 다 데모.
assert.deepEqual(fifth(null).consoles, { merchant: MERCHANT_DEMO_PATH, admin: ADMIN_DEMO_PATH });
assert.deepEqual(fifth(acct('tourist', true)).consoles, { merchant: MERCHANT_DEMO_PATH, admin: ADMIN_DEMO_PATH });
// 사장님 → 자기 콘솔은 실제로, 관제는 데모로.
assert.deepEqual(fifth(acct('merchant')).consoles, { merchant: MERCHANT_CONSOLE_PATH, admin: ADMIN_DEMO_PATH });
// 관리자 → 관제만 실제로.
assert.deepEqual(fifth(acct('admin')).consoles, { merchant: MERCHANT_DEMO_PATH, admin: ADMIN_CONSOLE_PATH });
// 역할과 무관하게 1~4번은 같은 곳으로 간다(관광객 기능은 누구에게나 같다).
assert.deepEqual(
  featureShortcuts(acct('admin')).slice(0, 4).map((row) => row.href),
  guestRows.slice(0, 4).map((row) => row.href),
);

console.log('featureShortcuts tests passed');
