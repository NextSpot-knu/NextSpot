import assert from 'node:assert/strict';

import {
  MODAL_SHEET_INITIAL,
  modalSheetReduce,
  type ModalSheetAction,
  type ModalSheetEvent,
  type ModalSheetState,
} from './modalSheetState';

// ── 1. 전이 표 ─────────────────────────────────────────────────────────

function run(events: ModalSheetEvent[], from: ModalSheetState = MODAL_SHEET_INITIAL) {
  let state = from;
  const actions: ModalSheetAction[] = [];
  for (const e of events) {
    const r = modalSheetReduce(state, e);
    state = r.state;
    actions.push(...r.actions);
  }
  return { state, actions };
}

// 닫힌 채 처음 마운트 — dismiss 하지 않는다(G2-G07 원래 버그).
assert.deepEqual(run([{ type: 'open', value: false }]).actions, []);
// 열기 → 보임 → 부모가 닫음 → onDismiss: 알리지 않는다(부모가 이미 안다).
assert.deepEqual(
  run([{ type: 'open', value: true }, { type: 'shown' }, { type: 'open', value: false }, { type: 'dismissed' }]),
  { state: { ...MODAL_SHEET_INITIAL }, actions: ['present', 'dismiss'] },
);
// 바탕 누르기·끌어 내리기(gorhom 이 스스로 닫음) → 부모에게 알린다.
assert.deepEqual(run([{ type: 'open', value: true }, { type: 'shown' }, { type: 'dismissed' }]).actions, ['present', 'notifyClose']);
// 빠른 열고 닫기: 보이기 전 닫기는 미뤘다가 보이자마자 닫는다.
{
  const r = run([{ type: 'open', value: true }, { type: 'open', value: false }]);
  assert.deepEqual(r.actions, ['present']);
  assert.equal(r.state.phase, 'presenting');
  const r2 = run([{ type: 'shown' }], r.state);
  assert.deepEqual(r2.actions, ['dismiss']);
  assert.deepEqual(run([{ type: 'dismissed' }], r2.state).actions, []);
}
// 열고 → 닫고 → 다시 열기(보이기 전): 닫기 요청이 사라지고 그대로 열린 채.
assert.deepEqual(
  run([{ type: 'open', value: true }, { type: 'open', value: false }, { type: 'open', value: true }, { type: 'shown' }]).state.phase,
  'live',
);
// 닫히는 중에 다시 열기 → onDismiss 에서 다시 올린다.
assert.deepEqual(
  run([{ type: 'open', value: true }, { type: 'shown' }, { type: 'open', value: false }, { type: 'open', value: true }, { type: 'dismissed' }]).actions,
  ['present', 'dismiss', 'present'],
);
// 사용자 닫기(뒤로 키)를 보이기 전에 누름 → 보이자마자 닫고 부모에게 알린다.
assert.deepEqual(
  run([{ type: 'open', value: true }, { type: 'userClose' }, { type: 'shown' }, { type: 'dismissed' }]).actions,
  ['present', 'dismiss', 'notifyClose'],
);
// 열린 시트에서 사용자 닫기 → dismiss → 알림. 닫힌 시트에서 사용자 닫기는 아무 일 없음.
assert.deepEqual(run([{ type: 'open', value: true }, { type: 'shown' }, { type: 'userClose' }, { type: 'dismissed' }]).actions, ['present', 'dismiss', 'notifyClose']);
assert.deepEqual(run([{ type: 'userClose' }]).actions, []);
// 같은 값 반복(StrictMode 효과 두 번) · 여러 번의 shown(onAnimate + onChange)은 한 번만.
assert.deepEqual(run([{ type: 'open', value: true }, { type: 'open', value: true }, { type: 'shown' }, { type: 'shown' }]).actions, ['present']);

// ── 2. gorhom 5.2.14 상태 흉내로 '갇힘'을 재현 ─────────────────────────
// BottomSheetModal 의 handlePresent(rAF 뒤 마운트) · handleDismiss(INITIAL → DISMISSING) · handlePortalRender(DISMISSING 이면
// 안 그림) · BottomSheet.forceClose(자리 재기 전이면 돌아감)만 옮겼다.

type Status = 'INITIAL' | 'ANIMATING' | 'PRESENTED' | 'DISMISSING' | 'DISMISSED';
class FakeGorhom {
  status: Status = 'INITIAL';
  mounted = false;
  sheetRendered = false; // 포털이 BottomSheet 를 그림(=bottomSheetRef 있음)
  laidOut = false; // closedDetentPosition 이 정해짐
  index = -1;
  private raf: Array<() => void> = [];
  private pending: Array<() => void> = [];
  constructor(private cb: { onShown: () => void; onDismiss: () => void }) {}
  present() {
    this.raf.push(() => {
      if (this.mounted && this.sheetRendered) { this.status = 'ANIMATING'; this.animateTo(0); }
      this.mounted = true;
      this.renderPortal();
    });
  }
  dismiss() {
    if (this.status === 'DISMISSING' && this.index === -1) { this.unmount(); return; } // 이미 닫힌 자리면 바로 정리
    this.status = 'DISMISSING';
    if (this.sheetRendered && this.laidOut) this.animateTo(-1); // forceClose
  }
  private renderPortal() {
    if (this.status === 'DISMISSING') return; // handlePortalRender
    if (this.sheetRendered) return;
    this.sheetRendered = true;
    this.pending.push(() => { this.laidOut = true; this.animateTo(0); }); // 자리를 잰 뒤 animateOnMount
  }
  private animateTo(target: number) {
    if (target >= 0) {
      if (this.status !== 'DISMISSING') this.status = 'ANIMATING';
      this.cb.onShown(); // onAnimate(목표 ≥ 0)
      this.pending.push(() => { if (this.status === 'ANIMATING') { this.index = target; this.status = 'PRESENTED'; this.cb.onShown(); } });
    } else {
      this.pending.push(() => { this.index = -1; if (this.status === 'DISMISSING') { this.status = 'DISMISSED'; this.unmount(); } });
    }
  }
  private unmount() {
    this.status = 'INITIAL'; this.index = -1; this.mounted = false; this.sheetRendered = false; this.laidOut = false;
    this.cb.onDismiss();
  }
  /** rAF·레이아웃·애니메이션을 다 흘려보낸다. */
  flush() {
    for (let i = 0; i < 50 && (this.raf.length || this.pending.length); i++) {
      const job = this.raf.shift() ?? this.pending.shift();
      job?.();
    }
  }
  get visible() { return this.sheetRendered && this.status !== 'DISMISSING' && this.index >= 0; }
}

/** 새 ModalSheet: 상태 기계로 gorhom 을 부른다. */
function newSheet() {
  let state = MODAL_SHEET_INITIAL;
  let closes = 0;
  const g: FakeGorhom = new FakeGorhom({ onShown: () => send({ type: 'shown' }), onDismiss: () => send({ type: 'dismissed' }) });
  function send(e: ModalSheetEvent) {
    const r = modalSheetReduce(state, e);
    state = r.state;
    for (const a of r.actions) {
      if (a === 'present') g.present();
      else if (a === 'dismiss') g.dismiss();
      else closes += 1;
    }
  }
  return { g, setOpen: (v: boolean) => send({ type: 'open', value: v }), userClose: () => send({ type: 'userClose' }), closes: () => closes };
}

/** 옛 ModalSheet(A1 이전): open 이 바뀔 때마다 present/dismiss. */
function oldSheet() {
  const g = new FakeGorhom({ onShown: () => {}, onDismiss: () => {} });
  return { g, setOpen: (v: boolean) => (v ? g.present() : g.dismiss()) };
}
/** A1 첫 판(presentedRef): 연 적 있으면 dismiss. */
function presentedRefSheet() {
  let presented = false;
  const g = new FakeGorhom({ onShown: () => {}, onDismiss: () => { presented = false; } });
  return { g, setOpen: (v: boolean) => { if (v) { presented = true; g.present(); } else if (presented) g.dismiss(); } };
}

// 흉내가 버그를 재현하는지 먼저 확인한다(그래야 아래 통과가 의미 있다).
{
  const s = oldSheet();
  s.setOpen(false); s.g.flush(); // 닫힌 채 처음 마운트
  s.setOpen(true); s.g.flush();
  assert.equal(s.g.visible, false, '옛 판: 처음 마운트 dismiss 로 갇혀야 한다');
}
{
  const s = presentedRefSheet();
  s.setOpen(false); s.g.flush();
  s.setOpen(true); s.setOpen(false); s.g.flush(); // 칩 두 번 누르기(rAF 전)
  s.setOpen(true); s.g.flush();
  assert.equal(s.g.visible, false, 'presentedRef 판: 빠른 열고 닫기로 갇혀야 한다');
}

// 새 판은 어떤 순서로도 갇히지 않는다.
{
  const s = newSheet();
  s.setOpen(false); s.g.flush();
  s.setOpen(true); s.g.flush();
  assert.equal(s.g.visible, true, '처음 열기');
  s.setOpen(false); s.g.flush();
  assert.equal(s.g.visible, false, '닫기');
  s.setOpen(true); s.g.flush();
  assert.equal(s.g.visible, true, '다시 열기');
  assert.equal(s.closes(), 0, '부모가 닫은 것은 알리지 않는다');
}
for (const gap of ['beforeRaf', 'beforeLayout'] as const) {
  const s = newSheet();
  s.setOpen(false); s.g.flush();
  s.setOpen(true);
  if (gap === 'beforeLayout') {
    // rAF 만 흘려 포털이 그려졌지만 자리를 재기 전(forceClose 가 돌아가는 구간)
    (s.g as unknown as { raf: Array<() => void> }).raf.shift()?.();
    assert.equal(s.g.sheetRendered, true);
    assert.equal(s.g.laidOut, false);
  }
  s.setOpen(false); s.g.flush();
  assert.equal(s.g.visible, false, `${gap}: 닫혀 있어야 한다`);
  assert.equal(s.g.status, 'INITIAL', `${gap}: gorhom 상태가 처음으로 돌아와야 한다`);
  s.setOpen(true); s.g.flush();
  assert.equal(s.g.visible, true, `${gap}: 다시 열려야 한다`);
}
{
  // 뒤로 키를 열리기 전에 누름 → 닫히고 부모에게 한 번 알린다 → 부모가 false → 다시 열 수 있다.
  const s = newSheet();
  s.setOpen(true); s.userClose(); s.g.flush();
  assert.equal(s.g.visible, false);
  assert.equal(s.closes(), 1);
  s.setOpen(false); s.g.flush();
  s.setOpen(true); s.g.flush();
  assert.equal(s.g.visible, true);
}
{
  // 닫히는 중에 다시 열기.
  const s = newSheet();
  s.setOpen(true); s.g.flush();
  s.setOpen(false); s.setOpen(true); s.g.flush();
  assert.equal(s.g.visible, true);
}

console.log('modalSheetState ok');
