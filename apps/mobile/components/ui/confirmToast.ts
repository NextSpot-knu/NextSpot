// 되돌릴 수 없는 동작의 확인 — 웹처럼 화면 아래 토스트에 [취소][행동] 버튼(웹 saved/page.tsx '전체 초기화',
// mypage/settings/page.tsx 초기화·계정 삭제). OS 대화상자(Alert)는 웹 빌드에서 window.confirm 이 되고 화면을 막는다(G4a-12 · G5b-35).
// docs/MOBILE_WEB_PARITY.md §4.2 F9 · §4.3 '확인 토스트 자리'. 결정 D17(a).
//
// sonner-native 0.27 과 웹 sonner 의 다른 점은 toast(Toast.tsx)가 맞춘다: 버튼 순서 취소 → 행동(웹 순서),
// 글자 오른쪽 같은 줄, 행동을 눌러도 닫힌다(onClick 뒤 toast.dismiss(id)).
// 답: 행동 = true · 취소 · 밀어 닫기 · 시간 초과 · 같은 id 의 새 확인 = false. 약속은 한 번만 풀린다(confirmToastCore).
import { createConfirmRegistry } from './confirmToastCore';
import { toast } from './Toast';

export type ConfirmDestructiveInput = {
  /** 제목(웹 toast 첫 인자, 예: t('saved.clearConfirm')). */
  title: string;
  /** 설명(웹 description, 예: t('saved.clearConfirmDesc')). */
  message?: string;
  /** 행동 버튼(검정, 예: t('saved.clearAction')). */
  confirmLabel: string;
  /** 취소 버튼(회색, 예: t('common.cancel')). */
  cancelLabel: string;
  /** 답을 기다리는 시간(ms). 기본 8000 — 웹 '전체 초기화'·데이터 초기화. 계정 삭제는 웹 10000. */
  duration?: number;
  /** 토스트 id. 같은 id 로 다시 부르면 앞 확인은 false 로 끝나고 토스트가 바뀐다. 기본은 부를 때마다 새 id. */
  id?: string;
  /** RN Modal 안 채널(예: 'profileEdit')에 띄울 때. */
  toasterId?: string;
};

const DEFAULT_DURATION = 8000;

const registry = createConfirmRegistry();
let seq = 0;

/**
 * 화면 아래 토스트로 확인을 받는다. 화면을 막지 않고, 답이 없으면 duration 뒤 false.
 * features/mypage/confirm.ts(OS 대화상자)와 같은 입력이라 가져오는 곳만 바꾸면 된다(화면 묶음 D2·D6).
 */
export function confirmDestructive(input: ConfirmDestructiveInput): Promise<boolean> {
  const id = input.id ?? `confirm-destructive-${++seq}`;
  return new Promise<boolean>((resolve) => {
    registry.open(id, resolve);
    const answer = (value: boolean) => () => {
      registry.settle(id, value, resolve);
    };
    toast(input.title, {
      id,
      description: input.message,
      duration: input.duration ?? DEFAULT_DURATION,
      toasterId: input.toasterId,
      // 누르면 답을 먼저 정하고, 그다음 toast 가 닫는다(toast.dismiss(id) → onAutoClose 의 false 는 이미 답해서 버려진다).
      action: { label: input.confirmLabel, onClick: answer(true) },
      cancel: { label: input.cancelLabel, onClick: answer(false) },
      onDismiss: answer(false),
      onAutoClose: answer(false),
    });
  });
}
