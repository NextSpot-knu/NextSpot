// 자리 키 어긋남 판정 + 화면 배선 가드.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { slotKeysStale } from './courseSlotKeys';

const WEB = process.cwd();

// --- 같으면 어긋난 게 아니다 -------------------------------------------------
assert.equal(slotKeysStale([], []), false, '둘 다 비었으면 어긋난 것이 아니다(첫 로드)');
assert.equal(slotKeysStale(['a'], ['a']), false);
assert.equal(slotKeysStale(['a', 'b', 'c'], ['a', 'b', 'c']), false);

// --- 길이가 다르면 어긋났다 --------------------------------------------------
// 자동 모드(auto-0..2) → 순서 모드(uid 1개) 로 넘어가는 순간이 정확히 이 모양이다.
assert.equal(slotKeysStale(['auto-0', 'auto-1', 'auto-2'], ['cafe-17887-abc']), true);
assert.equal(slotKeysStale(['a'], []), true, '입력을 다 비운 직후도 어긋난 상태다');
assert.equal(slotKeysStale([], ['a']), true);

// --- 순서만 바뀌어도 어긋났다 ------------------------------------------------
// 자리 번호는 위치로 매기므로, 같은 키라도 자리가 바뀌면 옛 행의 핀은 다른 자리를 가리킨다.
assert.equal(slotKeysStale(['a', 'b'], ['b', 'a']), true, '드래그로 순서만 바꾼 창도 어긋난 것이다');

// --- 한 칸만 달라도 어긋났다 -------------------------------------------------
assert.equal(slotKeysStale(['a', 'b'], ['a', 'c']), true);

// --- 화면 배선 가드 ----------------------------------------------------------
// 판정만 맞고 화면이 옛 조건으로 남는 사고를 막는다(이 저장소의 다른 가드와 같은 이유).
{
  const page = readFileSync(join(WEB, 'app/course/page.tsx'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.match(page, /slotsStale/, 'course 화면이 slotsStale 을 쓰지 않는다');
  // 화면이 **이 함수**를 쓰는지까지 본다 — 같은 비교를 화면 안에 다시 적으면
  // 위 단위 테스트가 프로덕션 경로를 덮지 못한 채 초록으로 남는다.
  assert.match(page, /slotKeysStale\(renderedSlotKeys, slotKeys\)/, 'course 화면이 slotKeysStale 을 쓰지 않는다');
  assert.match(
    page,
    /const replanSupported = outcomes\.length > 0 && !slotsStale;/,
    "replanSupported 가 slotsStale 을 보지 않는다 — 어긋난 창에서 죽은 버튼이 다시 살아난다",
  );
  assert.match(page, /slotsStale=\{slotsStale\}/, 'StopRows 에 slotsStale 을 넘기지 않는다');
}

console.log('courseSlotKeys tests passed');
