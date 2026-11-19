import assert from 'node:assert/strict';

import { buildPhotoReportRow, hidePhoto, loadHiddenPhotos, reportPhoto, unhidePhoto, withoutHidden } from './photoSafety';
import type { KeyValueStore } from './tripLoop';

function memory(): KeyValueStore {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

async function main() {
  const s = memory();
  assert.deepEqual(loadHiddenPhotos(s), []);
  hidePhoto('https://a/1.jpg', s);
  hidePhoto('https://a/1.jpg', s);
  hidePhoto('https://a/2.jpg', s);
  assert.deepEqual(loadHiddenPhotos(s), ['https://a/1.jpg', 'https://a/2.jpg']);
  assert.deepEqual(withoutHidden(['https://a/1.jpg', 'https://a/3.jpg'], loadHiddenPhotos(s)), ['https://a/3.jpg']);
  unhidePhoto('https://a/1.jpg', s);
  assert.deepEqual(loadHiddenPhotos(s), ['https://a/2.jpg']);
  s.setItem('nextspot_hidden_photos', '{bad');
  assert.deepEqual(loadHiddenPhotos(s), []);

  const row = buildPhotoReportRow({ facilityId: 'f1', facilityName: '우직', photoUrl: 'https://x/p.jpg', userId: null, userName: null });
  assert.equal(row.user_id, null);
  assert.equal(row.user_name, '익명');
  assert.equal(row.type, '사진 신고');
  assert.equal(row.status, 'new');
  assert.ok(row.content.startsWith('facility_id: f1'));

  // 신고 전송 — 익명 세션이어도 inquiries 에 넣고, 오류면 false
  const inserted: unknown[] = [];
  const mk = (error: unknown, user: unknown) => ({
    auth: { getSession: async () => ({ data: { session: user ? { user } : null } }) },
    from: (table: string) => ({ insert: async (rows: unknown[]) => { assert.equal(table, 'inquiries'); inserted.push(...rows); return { error }; } }),
  });
  const ok = await reportPhoto(mk(null, { id: 'u1', email: 'a@b.c', user_metadata: {} }) as never, { facilityId: 'f1', facilityName: '우직', photoUrl: 'https://x/p.jpg' });
  assert.equal(ok, true);
  assert.equal((inserted[0] as { user_id: string; user_name: string }).user_id, 'u1');
  assert.equal((inserted[0] as { user_name: string }).user_name, 'a');
  assert.equal(await reportPhoto(mk({ message: 'rls' }, null) as never, { facilityId: 'f1', facilityName: 'n', photoUrl: 'u' }), false);
}

void main().then(() => console.log('photoSafety.test OK'));
