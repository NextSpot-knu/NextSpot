// 1단계 임시 화면 — 탭 셸만 먼저 연결한다. 2단계에서 각 묶음 에이전트가 실제 화면으로 바꾼다.
import { Screen, Text } from '~/components/ui';

export function TabPlaceholder({ title }: { title: string }) {
  return (
    <Screen className="flex-1 bg-hanji">
      <Text weight="bold" className="mt-[24px] text-[22px]">
        {title}
      </Text>
    </Screen>
  );
}
