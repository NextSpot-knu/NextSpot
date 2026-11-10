// 가정 시간 컨트롤(웹 대기·코스·홈 예측 띠의 '🕒 가정 시간 [지금 ▾]' + '가정: …' 배지) — D11 ①.
// 대기·코스가 같이 쓴다. 부모는 flex-row flex-wrap gap-[8px] 줄이어야 한다(웹 스탯 줄과 같다) — 이 컴포넌트는 두 조각을 나란히 낸다.
import { useSyncExternalStore } from 'react';
import { View } from 'react-native';

import { SelectField } from '~/components/ui/SelectField';
import { Text } from '~/components/ui/Text';
import {
  ASSUMED_TIME_PRESETS,
  assumedPresetLabelKey,
  getStoredAssumedPreset,
  setStoredAssumedPreset,
  subscribeAssumedPreset,
} from '~/lib/core/assumedTime';
import { useT } from '~/lib/i18n/I18nProvider';

/** 지금 고른 프리셋 id — 화면 사이에서 한 값을 같이 본다. 값이 바뀌면 다시 그린다. */
export function useAssumedPreset(): string {
  return useSyncExternalStore(subscribeAssumedPreset, getStoredAssumedPreset, () => 'now');
}

/** 'now' 가 아닐 때만 그리는 '가정: 토 14:00' 배지(웹 rounded-full bg-gold/15 border-gold/40 px-2.5 py-1 11px bold gold-deep). */
export function AssumedTimeBadge({ preset }: { preset?: string }) {
  const t = useT();
  const stored = useAssumedPreset();
  const id = preset ?? stored;
  if (id === 'now') return null;
  return (
    <View className="self-start rounded-full border border-gold/40 bg-gold/15 px-[10px] py-[4px]">
      <Text className="text-[11px] leading-[16.5px] text-gold-deep" weight="bold">
        {t('timeSim.badge', { label: t(assumedPresetLabelKey(id)) })}
      </Text>
    </View>
  );
}

export function AssumedTimeSelect() {
  const t = useT();
  const preset = useAssumedPreset();
  const options = ASSUMED_TIME_PRESETS.map((p) => ({ value: p.id, label: t(p.labelKey) }));
  return (
    <>
      <SelectField
        variant="control"
        value={preset}
        options={options}
        onChange={setStoredAssumedPreset}
        accessibilityLabel={t('timeSim.label')}
        label={t('timeSim.label')}
        leading={<Text className="text-[13px]">🕒</Text>}
      />
      <AssumedTimeBadge preset={preset} />
    </>
  );
}
