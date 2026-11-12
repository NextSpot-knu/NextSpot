// ModalSheet 의 열림·닫힘 판단 — react-native 를 import 하지 않는 순수 상태 기계(modalSheetState.test.ts 로 잠근다).
//
// 왜 필요한가(@gorhom/bottom-sheet 5.2.14, src/components/bottomSheetModal/BottomSheetModal.tsx):
// - present() 는 requestAnimationFrame 뒤에야 포털을 붙이고, 안쪽 BottomSheet 가 자리를 재고 애니메이션을 시작할
//   때까지(onAnimate) 모달 상태는 INITIAL 이다.
// - 그 사이에 dismiss() 를 부르면 handleDismiss 가 INITIAL → DISMISSING 으로만 바꾸고 끝난다 — bottomSheetRef 가 아직
//   없거나, 있어도 forceClose 가 closedDetentPosition(자리 재기 전 undefined)에서 바로 돌아간다. onDismiss 는 오지 않고,
//   뒤의 present() 포털 그리기를 handlePortalRender 가 DISMISSING 이라 건너뛰어 시트가 영영 안 열린다(G2-G07).
//   닫힌 채 처음 마운트될 때의 dismiss() 와, 열자마자 닫기(칩 두 번 누르기 · 뒤로 키)가 같은 길이다.
// 그래서 dismiss() 는 시트가 '보이기 시작했다'(onAnimate 목표 index ≥ 0 또는 onChange index ≥ 0)고 알린 뒤에만 부르고,
// 그 전에 닫으라는 요청은 기억했다가 보이기 시작할 때 처리한다.

/**
 * idle — 그려진 시트 없음(처음 · onDismiss 뒤).
 * presenting — present() 를 불렀고 시트가 아직 보이기 시작했다고 알리지 않음(이때 dismiss() 하면 갇힌다).
 * live — 보이기 시작함(열리는 중이거나 열림). dismiss() 해도 된다.
 * dismissing — dismiss() 를 불렀고 onDismiss 를 기다린다.
 */
export type ModalSheetPhase = 'idle' | 'presenting' | 'live' | 'dismissing';

export interface ModalSheetState {
  phase: ModalSheetPhase;
  /** 부모가 준 open. */
  open: boolean;
  /** presenting 중에 사용자가 닫기를 눌렀다(뒤로 키 · 손잡이 · 읽기 화면 닫기) — 보이기 시작하면 닫는다. */
  userClosePending: boolean;
  /** 지금 닫히는 까닭 — 'prop' 은 부모가 open 을 false 로, 'user' 는 사용자 닫기 요청. null 은 gorhom 이 스스로 닫음(바탕 누르기 · 끌어 내리기). */
  dismissReason: 'prop' | 'user' | null;
}

export type ModalSheetEvent =
  | { type: 'open'; value: boolean }
  | { type: 'userClose' }
  /** onAnimate(목표 index ≥ 0) 또는 onChange(index ≥ 0). */
  | { type: 'shown' }
  /** onDismiss. */
  | { type: 'dismissed' };

/** present · dismiss = BottomSheetModal 메서드, notifyClose = 부모 onClose(사용자가 닫았음을 알림). */
export type ModalSheetAction = 'present' | 'dismiss' | 'notifyClose';

export const MODAL_SHEET_INITIAL: ModalSheetState = {
  phase: 'idle',
  open: false,
  userClosePending: false,
  dismissReason: null,
};

export function modalSheetReduce(
  state: ModalSheetState,
  event: ModalSheetEvent,
): { state: ModalSheetState; actions: ModalSheetAction[] } {
  switch (event.type) {
    case 'open': {
      const s = { ...state, open: event.value };
      if (event.value) {
        // 부모가 다시 열었으면 앞서 받은 사용자 닫기 요청은 버린다.
        s.userClosePending = false;
        if (state.phase === 'idle') return { state: { ...s, phase: 'presenting' }, actions: ['present'] };
        // presenting · live 는 이미 열리는 중, dismissing 은 onDismiss 에서 다시 연다.
        return { state: s, actions: [] };
      }
      if (state.phase === 'live') return { state: { ...s, phase: 'dismissing', dismissReason: 'prop' }, actions: ['dismiss'] };
      // idle(처음 마운트 포함): 할 일 없음 — 여기서 dismiss() 하면 갇힌다. presenting: 보이기 시작하면 닫는다.
      return { state: s, actions: [] };
    }
    case 'userClose': {
      if (state.phase === 'live') return { state: { ...state, phase: 'dismissing', dismissReason: 'user' }, actions: ['dismiss'] };
      if (state.phase === 'presenting') return { state: { ...state, userClosePending: true }, actions: [] };
      return { state, actions: [] };
    }
    case 'shown': {
      if (state.phase !== 'presenting') return { state, actions: [] };
      if (!state.open) {
        return { state: { ...state, phase: 'dismissing', dismissReason: 'prop', userClosePending: false }, actions: ['dismiss'] };
      }
      if (state.userClosePending) {
        return { state: { ...state, phase: 'dismissing', dismissReason: 'user', userClosePending: false }, actions: ['dismiss'] };
      }
      return { state: { ...state, phase: 'live' }, actions: [] };
    }
    case 'dismissed': {
      const base: ModalSheetState = { ...state, phase: 'idle', dismissReason: null, userClosePending: false };
      if (state.dismissReason === 'prop') {
        // 부모가 닫았다 — 그사이 다시 열었으면 다시 올린다. 알릴 필요는 없다(부모가 이미 안다).
        return state.open ? { state: { ...base, phase: 'presenting' }, actions: ['present'] } : { state: base, actions: [] };
      }
      // 사용자 · gorhom 이 닫았다 — 부모에게 알린다(부모가 open 을 false 로).
      return { state: base, actions: ['notifyClose'] };
    }
  }
}
