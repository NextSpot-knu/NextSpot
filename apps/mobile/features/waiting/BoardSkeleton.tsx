// 보드가 오는 동안의 자리표시 — 섹터 패널 한 판의 모양(머리 칩 + 포트레이트 카드 + 행)을 미리 보여 준다.
// 읽기 화면에서는 한 덩어리로 '불러오는 중'만 알린다(Skeleton 은 스스로 숨는다).
import { View } from 'react-native';

import { Skeleton } from '~/components/ui';

export function SectorSkeleton() {
  return (
    <View className="rounded-3xl border border-line/70 bg-white/60 p-[12px]" aria-hidden>
      <View className="mb-[10px] flex-row items-center gap-[8px]">
        <Skeleton width={32} height={32} radius={12} />
        <Skeleton width={96} height={16} />
      </View>
      <View className="flex-row gap-[8px]">
        <Skeleton width="80%" height={316} radius={16} />
        <Skeleton width="30%" height={316} radius={16} />
      </View>
      <View className="mt-[10px] gap-[8px]">
        <Skeleton height={68} radius={16} />
        <Skeleton height={68} radius={16} />
      </View>
    </View>
  );
}

export function BoardSkeleton({ label }: { label: string }) {
  return (
    <View className="gap-[24px]" accessible accessibilityLabel={label} accessibilityState={{ busy: true }}>
      <SectorSkeleton />
      <SectorSkeleton />
    </View>
  );
}
