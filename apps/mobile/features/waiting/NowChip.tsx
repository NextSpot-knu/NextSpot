// 현재 시각 칩 — "현재 14:32 기준". 보드 숫자가 어느 시점 기준인지 명시한다(웹 components/NowChip.tsx). 30초마다 갱신.
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Text } from '~/components/ui';
import { useT } from '~/lib/i18n/I18nProvider';

export function formatClock(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function NowChip() {
  const t = useT();
  const [now, setNow] = useState(() => formatClock(new Date()));
  useEffect(() => {
    const id = setInterval(() => setNow(formatClock(new Date())), 30_000);
    return () => clearInterval(id);
  }, []);
  return (
    <View className="flex-row items-center gap-[6px] self-start rounded-full border border-line bg-hanji-deep/70 px-[10px] py-[3px]">
      <View className="h-[6px] w-[6px] rounded-full bg-jade" accessibilityElementsHidden importantForAccessibility="no" />
      <Text className="text-[11px] text-muk-soft" weight="medium">
        {t('common.nowTime', { time: now })}
      </Text>
    </View>
  );
}
