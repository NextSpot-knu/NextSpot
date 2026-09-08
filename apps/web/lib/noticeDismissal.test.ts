// 공지 닫기 기억 — 가장 중요한 성질은 "새 공지는 다시 뜬다" 이다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDismissedNotice, shouldShowNotice, writeDismissedNotice } from './noticeDismissal';

const WEB = process.cwd();

// --- 브라우저 저장소 흉내 ----------------------------------------------------
function installStorage(impl?: Partial<Storage>): Map<string, string> {
  const store = new Map<string, string>();
  const base = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  };
  const localStorage = { ...base, ...impl } as unknown as Storage;
  (globalThis as Record<string, unknown>).window = { localStorage };
  (globalThis as Record<string, unknown>).localStorage = localStorage;
  return store;
}

const NOTICE_A = '9월 12일 축제로 황리단길 일부 구간이 통제됩니다.';
const NOTICE_B = '점검이 예정되어 있습니다.';

// --- 판정: 빈 공지는 보여 줄 것이 없다 --------------------------------------
assert.equal(shouldShowNotice('', null), false);
assert.equal(shouldShowNotice('', NOTICE_A), false);

// --- 닫지 않았으면 보여 준다 -------------------------------------------------
assert.equal(shouldShowNotice(NOTICE_A, null), true);

// --- 닫은 그 문구는 숨긴다 ---------------------------------------------------
assert.equal(shouldShowNotice(NOTICE_A, NOTICE_A), false);

// --- ★ 문구가 바뀌면 다시 보여 준다 -----------------------------------------
// 불리언으로 기억했다면 여기서 false 가 나온다 = 한 번 닫은 사용자가 **진짜 공지를 영영 못 본다.**
assert.equal(shouldShowNotice(NOTICE_B, NOTICE_A), true, '새 공지가 옛 닫기에 묻혔다');
// 한 글자만 달라도 새 공지로 본다(운영자가 문구를 고쳐 다시 올리는 경우).
assert.equal(shouldShowNotice(NOTICE_A + ' ', NOTICE_A), true);

// --- 저장·읽기 왕복 ----------------------------------------------------------
{
  installStorage();
  assert.equal(readDismissedNotice(), null, '아무것도 안 닫았는데 값이 있다');
  writeDismissedNotice(NOTICE_A);
  assert.equal(readDismissedNotice(), NOTICE_A);
  assert.equal(shouldShowNotice(NOTICE_A, readDismissedNotice()), false);
  assert.equal(shouldShowNotice(NOTICE_B, readDismissedNotice()), true);
}

// --- 저장소가 막힌 브라우저에서도 죽지 않는다 --------------------------------
// 사파리 프라이빗·저장소 차단 설정에서 getItem/setItem 이 throw 한다. 여기서 예외가 새면
// 배너 렌더가 통째로 죽는다(= 공지가 안 보인다).
{
  installStorage({
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
  });
  assert.equal(readDismissedNotice(), null, '저장소 예외가 그대로 새어 나왔다');
  assert.doesNotThrow(() => writeDismissedNotice(NOTICE_A), '저장 실패가 예외로 새어 나왔다');
  // 기억은 못 하지만 배너는 정상 동작한다.
  assert.equal(shouldShowNotice(NOTICE_A, readDismissedNotice()), true);
}

// --- 화면 배선 가드 ----------------------------------------------------------
{
  const provider = readFileSync(join(WEB, 'components/shell/PublicSettingsProvider.tsx'), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.match(provider, /shouldShowNotice\(/, '프로바이더가 공지 표시 판정을 쓰지 않는다');
  assert.match(provider, /writeDismissedNotice\(/, '닫기를 기기에 기억하지 않는다 — 새로고침마다 다시 뜬다');
  assert.match(provider, /readDismissedNotice\(/, '기억한 닫기를 읽지 않는다');
  assert.doesNotMatch(
    provider,
    /useState\(false\)[^\n]*\n?[^\n]*noticeDismissed|noticeDismissed/,
    '불리언 닫기 상태가 남아 있다 — 그러면 다음 진짜 공지가 묻힌다',
  );
}

console.log('noticeDismissal tests passed');
