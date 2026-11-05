// 1단계 임시 화면 — 탭 셸만 먼저 연결한다. 2단계에서 각 묶음 에이전트가 실제 화면으로 바꾼다.
// 아래 안전 영역은 탭 막대가 맡으므로 비우지 않는다(겹치면 탭 위에 빈 띠가 생긴다).
import { Screen, Text } from '~/components/ui';

const TAB_EDGES = ['top', 'left', 'right'] as const;

export function TabPlaceholder({ title }: { title: string }) {
  return (
    <Screen edges={TAB_EDGES} className="flex-1 bg-hanji">
      <Text weight="bold" className="mt-[24px] text-[22px]">
        {title}
      </Text>
    </Screen>
  );
}
