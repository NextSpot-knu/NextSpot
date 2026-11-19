// 대기 보드에 올릴 곳이 하나도 없을 때(밤·가정 시간) — 웹 waiting/page.tsx 의 화면 전용 EmptyState(G5a-21).
// '없어요' 대신 바로 할 수 있는 다음 행동 하나(지도에서 고르기). 공용 EmptyState 는 다른 화면이 써서 건드리지 않는다.
import { Button } from '~/components/ui/Button';
import { Card } from '~/components/ui/Card';
import { Text } from '~/components/ui/Text';

export function BoardEmpty({
  title,
  body,
  ctaLabel,
  onCta,
}: {
  title: string;
  body: string;
  ctaLabel: string;
  onCta: () => void;
}) {
  return (
    <Card className="items-center gap-[12px]" padded={false} style={{ padding: 32 }}>
      <Text className="text-[36px] leading-[40px]" accessibilityElementsHidden importantForAccessibility="no">
        🗺️
      </Text>
      {/* 웹 제목은 <p> — 헤더 역할을 주지 않는다(h1 이 둘이 되지 않게, G5a-25). */}
      <Text className="text-center text-[15px] leading-[22.5px]" weight="bold">
        {title}
      </Text>
      <Text className="text-center text-[13px] leading-[21.125px] text-muk-soft">{body}</Text>
      <Button label={ctaLabel} labelSize={13} shape="full" paddingX={20} onPress={onCta} />
    </Card>
  );
}
