// 전면 점검 안내 — 웹 apps/web/components/shell/PublicSettingsProvider.tsx:139-157 의 MaintenanceScreen(G2-34, R1 정정).
// 관광객 앱의 모든 화면을 대신한다. 루트 app/_layout 의 ProvidersWithLabels 가 renderMaintenance 로 넘긴다.
//   바탕 hanji px-6 가운데 · 묶음 max-w-sm space-y-3 text-center
//   렌치 원 56 border-gold/30 bg-gold/10 + Wrench 24 gold-deep · h1 text-xl(20/28) bold · 본문 14 leading-relaxed(22.75) muk-soft
//   공지(있을 때만 — 지어내지 않는다): 카드 rounded-2xl border-line bg-white px-4 py-3 12px leading-relaxed(19.5) muk, 그림자 없음
import { Wrench } from 'lucide-react-native';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Card } from '~/components/ui/Card';
import { Icon } from '~/components/ui/Icon';
import { Text } from '~/components/ui/Text';
import type { PublicSettingsLabels } from '~/lib/core/publicSettings';

/** 웹 max-w-sm. */
const MAX_WIDTH = 384;

export type AppMaintenanceScreenProps = {
  noticeText: string;
  labels: PublicSettingsLabels;
};

export function AppMaintenanceScreen({ noticeText, labels }: AppMaintenanceScreenProps) {
  const insets = useSafeAreaInsets();
  return (
    <View
      className="flex-1 items-center justify-center bg-hanji px-[24px]"
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
    >
      <View className="w-full gap-[12px]" style={{ maxWidth: MAX_WIDTH }}>
        <View className="h-[56px] w-[56px] items-center justify-center self-center rounded-full border border-gold/30 bg-gold/10">
          <Icon icon={Wrench} size={24} color="gold-deep" />
        </View>
        <Text weight="bold" accessibilityRole="header" className="text-center text-[20px] leading-[28px]">
          {labels.maintenanceTitle}
        </Text>
        <Text className="text-center text-[14px] leading-[22.75px] text-muk-soft">{labels.maintenanceBody}</Text>
        {noticeText !== '' ? (
          <Card padded={false} elevation="none" className="px-[16px] py-[12px]">
            <Text className="text-center text-[12px] leading-[19.5px] text-muk">{noticeText}</Text>
          </Card>
        ) : null}
      </View>
    </View>
  );
}
