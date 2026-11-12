// 가드레일 경고 문구 — 코드를 그대로 뿌리던 자리를 잠근다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeGuardrailWarnings } from './adminGuardrailWarnings';

const WEB = process.cwd();

// --- 아는 코드는 문장이 된다 -------------------------------------------------
const known = describeGuardrailWarnings(['trained_false', 'metrics_truncated']);
assert.equal(known.length, 2);
assert.ok(known.every((w) => w.known), '아는 코드를 모른다고 표시했다');
assert.ok(known.every((w) => !w.text.includes('_')), `코드가 문장에 그대로 남았다: ${JSON.stringify(known)}`);

// --- 모르는 코드는 숨기지 않되, 내부 식별자를 화면 문장에 싣지 않는다 ---------
// 항목이 '있다'는 사실은 유지하고(개수·경고 톤에 반영), 원문 코드는 code 필드로만 남긴다 —
// 화면 문장과 진단용 원문 코드를 분리한다.
const unknown = describeGuardrailWarnings(['brand_new_code']);
assert.equal(unknown.length, 1, '모르는 경고를 버렸다');
assert.deepEqual(unknown[0], {
  code: 'brand_new_code',
  text: '운영 점검 항목이 추가되었습니다 — 상세는 운영 로그에서 확인해 주세요.',
  known: false,
});

// --- 빈/깨진 입력 ------------------------------------------------------------
assert.deepEqual(describeGuardrailWarnings([]), []);
assert.deepEqual(describeGuardrailWarnings(null), []);
assert.deepEqual(describeGuardrailWarnings(undefined), []);
assert.deepEqual(describeGuardrailWarnings(['', '   ']), [], '빈 문자열이 경고 1건으로 세어졌다');

// --- 백엔드가 내보내는 코드를 **전부** 알고 있는가 ---------------------------
// 이 대조가 없으면 백엔드에 코드가 하나 늘 때 화면에서만 조용히 원문으로 새어 나온다.
{
  const admin = readFileSync(join(WEB, '../api/app/routers/admin.py'), 'utf8');
  const emitted = [...admin.matchAll(/warnings\.append\("([a-z_]+)"\)/g)].map((m) => m[1]);
  assert.ok(emitted.length >= 8, `admin.py 에서 경고 코드를 찾지 못했다(${emitted.length}건) — 정규식이 낡았는지 확인할 것`);
  const unmapped = describeGuardrailWarnings(emitted).filter((w) => !w.known).map((w) => w.code);
  assert.deepEqual(unmapped, [], `백엔드가 내보내는데 문구가 없는 코드: ${unmapped.join(', ')}`);
}

// --- 화면 배선 가드 ----------------------------------------------------------
{
  const panel = readFileSync(join(WEB, 'components/admin/ModelTrustPanel.tsx'), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.match(panel, /describeGuardrailWarnings/, '패널이 이 함수를 쓰지 않는다');
  assert.doesNotMatch(panel, /warnings\.join\(/, '패널이 아직 코드를 그대로 이어 붙인다');
}

console.log('adminGuardrailWarnings tests passed');
