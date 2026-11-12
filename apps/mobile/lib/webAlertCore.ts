// 웹 대화상자(window.alert · window.confirm)로 RN Alert 버튼을 옮기는 규칙 — 순수 함수(테스트: webAlertCore.test.ts).
// 쓰는 곳은 lib/webSetup.web.ts 하나다. 네이티브는 OS 대화상자를 그대로 쓴다.

export interface AlertButtonLike {
  text?: string;
  style?: 'default' | 'cancel' | 'destructive';
  // 인자 없이 부른다(대화상자에 입력 칸이 없다) — RN AlertButton 의 여러 onPress 모양을 다 받게 never.
  onPress?: (value?: never) => void;
}

export interface AlertOptionsLike {
  cancelable?: boolean;
  onDismiss?: () => void;
}

export type AlertPick =
  /** 버튼이 하나 이하 — 알림만(확인을 누르면 그 버튼). */
  | { kind: 'notice'; onClose?: () => void }
  /** 둘 이상 — 확인 = 마지막 '취소 아닌' 버튼, 취소 = 닫기(cancelable 이면 onDismiss, 아니면 취소 버튼). */
  | { kind: 'confirm'; onConfirm?: () => void; onCancel?: () => void };

export function pickAlertButtons(buttons: readonly AlertButtonLike[], options?: AlertOptionsLike): AlertPick {
  if (buttons.length <= 1) {
    const only = buttons[0];
    return { kind: 'notice', onClose: only?.onPress ? () => only.onPress?.() : undefined };
  }
  const confirm = [...buttons].reverse().find((b) => b.style !== 'cancel') ?? buttons[buttons.length - 1];
  const cancel = buttons.find((b) => b.style === 'cancel');
  // 브라우저 '취소' 는 '고르지 않고 닫음' 에 가깝다 — 닫기 처리가 따로 있으면 그쪽(예: 외부 AI 동의는 거절로 굳히지 않고 다음에 다시 묻는다).
  const onCancel = options?.cancelable && options.onDismiss
    ? options.onDismiss
    : cancel?.onPress ? () => cancel.onPress?.() : undefined;
  return { kind: 'confirm', onConfirm: confirm.onPress ? () => confirm.onPress?.() : undefined, onCancel };
}
