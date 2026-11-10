// 대기 보드 조회 실패 — 웹 waiting/page.tsx 의 화면 전용 ErrorState(G5a-22). 공용 ErrorState(알약 12px)와 달리 이 화면은
// 36px ⚠️ + 15px 굵은 메시지 + 주 행동 그라데이션 알약(cta, 13px bold, 아이콘 없음)이다. 공용 variant 를 만들지 않고 따로 둔다(§4.3).
// 읽기 화면 알림은 공용 useAnnounce 로 남긴다(웹 role 은 없지만 앱 읽기 화면은 나타날 때 읽지 않는다).
import { Button } from '~/components/ui/Button';
import { Card } from '~/components/ui/Card';
import { useAnnounce } from '~/components/ui/ErrorState';
import { Text } from '~/components/ui/Text';

const ERROR_BORDER = 'rgba(193, 85, 59, 0.25)'; // terracotta 25%

export function BoardError({ message, retryLabel, onRetry }: { message: string; retryLabel: string; onRetry: () => void }) {
  useAnnounce(message);
  return (
    <Card className="items-center gap-[12px]" padded={false} style={{ padding: 32, borderColor: ERROR_BORDER }} accessibilityRole="alert">
      <Text className="text-[36px] leading-[40px]">⚠️</Text>
      <Text className="text-center text-[15px] leading-[22.5px]" weight="bold">
        {message}
      </Text>
      <Button label={retryLabel} labelSize={13} shape="full" paddingX={20} onPress={onRetry} />
    </Card>
  );
}
