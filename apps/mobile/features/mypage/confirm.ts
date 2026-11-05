// 되돌릴 수 없는 동작의 확인 대화상자 — 웹은 sonner 토스트 action/cancel 로 받았다. 앱은 OS 대화상자(읽기 화면·뒤로 가기 처리가 기본).
import { Alert } from 'react-native';

export function confirmDestructive(input: {
  title: string;
  message?: string;
  confirmLabel: string;
  cancelLabel: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      input.title,
      input.message,
      [
        { text: input.cancelLabel, style: 'cancel', onPress: () => resolve(false) },
        { text: input.confirmLabel, style: 'destructive', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}
