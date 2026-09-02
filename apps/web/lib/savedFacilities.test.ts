import assert from 'node:assert/strict';
import { mergeSaved, type SavedRecord } from './savedFacilities';

// 저장 목록 병합 규칙. 실제로 났던 버그는 '지운 북마크가 되살아난다' 였다:
// 병합이 union 이라, 원격 삭제가 실패해 행이 남아 있으면 다음 동기화가 그대로 되돌려 놓는다.
// supabase-js 가 RLS·HTTP 오류에 예외를 던지지 않고 { error } 로 돌려주는 탓에 그 실패는
// try/catch 로는 보이지도 않았다.

const b = (id: string, name = id): SavedRecord => ({ id, name });

// 기본: id 기준 union.
assert.deepEqual(
  mergeSaved([b('a')], [b('c')]).map((x) => x.id),
  ['a', 'c'],
);

// 공유 id 는 원격 스냅샷이 이긴다(서버가 진실).
assert.equal(mergeSaved([b('a', '옛이름')], [b('a', '새이름')])[0].name, '새이름');

// 순서는 로컬 먼저 — 동기화 한 번에 화면이 재정렬되면 사용자는 목록이 바뀐 줄 안다.
assert.deepEqual(mergeSaved([b('a'), b('b')], [b('c'), b('a')]).map((x) => x.id), ['a', 'b', 'c']);

// ── 되살아남 방지 ──────────────────────────────────────────────────────────
// 원격에 남아 있어도 보류 삭제 id 는 빠진다. 이 줄이 그 버그를 잠근다.
assert.deepEqual(
  mergeSaved([], [b('a'), b('z')], ['a']).map((x) => x.id),
  ['z'],
  '지운 북마크가 원격에서 되살아났다',
);

// 로컬에 아직 남아 있는 경우에도(쓰기 실패 등) 보류 삭제가 이긴다.
assert.deepEqual(mergeSaved([b('a')], [b('a')], ['a']), []);

// 보류 삭제가 비면 아무것도 걸러내지 않는다.
assert.equal(mergeSaved([b('a')], [b('a')], []).length, 1);

// 빈 입력에도 안전해야 한다(첫 실행·오프라인).
assert.deepEqual(mergeSaved([], []), []);
assert.deepEqual(mergeSaved([], [], ['a']), []);

console.log('savedFacilities tests passed');
