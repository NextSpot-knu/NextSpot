// 가기 좋은 시간 한 줄 — GET /predict/golden-hour 의 '오늘 한산: 16~17시'. 시각만 보여 준다(알림 예약 버튼은 앱 v1 에 없다 —
// 계획 §3.1). 근거가 없거나 실패하면 조용히 숨는다. 웹 components/GoldenHourBadge.tsx 의 표시 부분.
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Text } from '~/components/ui';
import { useT } from '~/lib/i18n/I18nProvider';

import { fetchGoldenHour, type GoldenHour } from './api';

export function GoldenHourLabel({ facilityId, className }: { facilityId: string; className?: string }) {
  const t = useT();
  const [golden, setGolden] = useState<GoldenHour | null>(null);
  useEffect(() => {
    setGolden(null);
    const controller = new AbortController();
    let alive = true;
    void fetchGoldenHour(facilityId, controller.signal).then((g) => {
      if (alive) setGolden(g);
    });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [facilityId]);
  if (!golden) return null;
  return (
    <View className={`flex-row ${className ?? ''}`}>
      <View className="self-start rounded-md border border-jade/30 bg-jade/10 px-[8px] py-[4px]">
        <Text className="text-[11px] text-jade" weight="bold">
          {`🕐 ${t('golden.badge', { start: String(golden.start), end: String(golden.end) })}`}
        </Text>
      </View>
    </View>
  );
}
