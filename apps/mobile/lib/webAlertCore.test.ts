import assert from 'node:assert/strict';

import { pickAlertButtons } from './webAlertCore';

const log: string[] = [];
const btn = (name: string, style?: 'cancel' | 'destructive') => ({ text: name, style, onPress: () => log.push(name) });

// 버튼 없음 · 하나 → 알림.
assert.equal(pickAlertButtons([]).kind, 'notice');
const one = pickAlertButtons([btn('ok')]);
assert.equal(one.kind, 'notice');
if (one.kind === 'notice') one.onClose?.();
assert.deepEqual(log.splice(0), ['ok']);

// 취소 + 실행 → 확인은 실행, 취소는 취소 버튼(닫기 처리가 없으면).
const two = pickAlertButtons([btn('cancel', 'cancel'), btn('delete', 'destructive')]);
assert.equal(two.kind, 'confirm');
if (two.kind === 'confirm') {
  two.onConfirm?.();
  two.onCancel?.();
}
assert.deepEqual(log.splice(0), ['delete', 'cancel']);

// cancelable + onDismiss → 브라우저 '취소' 는 닫기로(거절 버튼을 누른 것으로 굳히지 않는다).
const dismissible = pickAlertButtons([btn('decline', 'cancel'), btn('allow')], { cancelable: true, onDismiss: () => log.push('dismiss') });
if (dismissible.kind === 'confirm') {
  dismissible.onCancel?.();
  dismissible.onConfirm?.();
}
assert.deepEqual(log.splice(0), ['dismiss', 'allow']);

// 취소 버튼에 onPress 가 없으면 취소는 아무것도 하지 않는다.
const silent = pickAlertButtons([{ text: 'cancel', style: 'cancel' }, btn('go')]);
assert.equal(silent.kind === 'confirm' && silent.onCancel, undefined);
