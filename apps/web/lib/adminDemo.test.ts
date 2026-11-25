import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ADMIN_DEMO_PATHS, adminDemoHref, isAdminDemoActive, isAdminDemoPath, setAdminDemoActive } from './adminDemo';

assert.equal(isAdminDemoPath('/admin'), true);
assert.equal(isAdminDemoPath('/admin/dashboard'), true);
assert.equal(isAdminDemoPath('/admin/reports/'), true);
assert.equal(isAdminDemoPath('/admin/simulator'), true);
// 심사 기간에 메뉴에서 감춘 화면과 로그인 화면은 데모가 아니다.
assert.equal(isAdminDemoPath('/admin/engine-validation'), false);
assert.equal(isAdminDemoPath('/admin/login'), false);
assert.equal(isAdminDemoPath('/merchant'), false);
assert.equal(isAdminDemoPath(null), false);
assert.equal(adminDemoHref('/admin/reports'), '/admin/reports?demo=1');

setAdminDemoActive(true);
assert.equal(isAdminDemoActive(), true);
setAdminDemoActive(false);
assert.equal(isAdminDemoActive(), false);

// 집합의 모든 화면이 실제로 있다 — 오타면 데모 사이드바가 404 로 간다.
for (const path of ADMIN_DEMO_PATHS) {
  assert.ok(existsSync(join(process.cwd(), 'app', ...path.split('/').filter(Boolean), 'page.tsx')), `${path} 화면이 없다`);
}

console.log('adminDemo.test: ok');
