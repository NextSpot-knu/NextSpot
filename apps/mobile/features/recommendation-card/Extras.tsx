import { Clock, Sparkles } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Icon, Text } from '~/components/ui';
import { apiClient } from '~/lib/core/apiClient';
import { colors } from '~/lib/theme/tokens';

import { useT } from '~/lib/i18n/I18nProvider';

interface GoldenHour {
  available: boolean;
  start?: number | null;
  end?: number | null;
}

/**
 * 골든타임 — '오늘 한산: 16~17시'. 웹 GoldenHourBadge 의 알림 예약(브라우저 Notification)은 옮기지 않았다 — 앱 v1 은 알림이 없다(계획 §3.1).
 * 백엔드 미기동·실패·모델 미학습은 조용히 숨긴다. enabled 가 false 면 부르지 않는다(추천 시트가 펼침에 닿기 전).
 */
export function GoldenHourLine({ facilityId, enabled = true }: { facilityId: string; enabled?: boolean }) {
  const t = useT();
  const [data, setData] = useState<GoldenHour | null>(null);
  useEffect(() => {
    setData(null);
    if (!enabled) return;
    let active = true;
    apiClient
      .get(`/predict/golden-hour?facilityId=${encodeURIComponent(facilityId)}`)
      .then((res) => active && setData(res as GoldenHour))
      .catch(() => active && setData(null));
    return () => {
      active = false;
    };
  }, [facilityId, enabled]);
  if (!data?.available || data.start == null || data.end == null) return null;
  return (
    <View className="min-h-[32px] flex-row items-center gap-[6px] self-start rounded-full border border-jade/30 bg-jade/10 px-[10px] py-[4px]">
      <Text className="text-[12px] leading-[16px] text-jade" weight="bold">
        {`🕐 ${t('golden.badge', { start: data.start, end: data.end })}`}
      </Text>
    </View>
  );
}

// 예측 모델이 학습돼 있는지 — 세션당 한 번(웹 lib/predictModel.ts). 미학습이면 /predict/day 는 늘 503 이라 묻지 않는다.
let trainedPromise: Promise<boolean> | null = null;
function isPredictModelTrained(): Promise<boolean> {
  trainedPromise ??= apiClient
    .get('/predict/model-info', { timeoutMs: 4000 })
    .then((res) => (res as { trained?: unknown } | null)?.trained === true)
    .catch(() => {
      trainedPromise = null; // 못 물었으면 다음에 다시 묻는다
      return false;
    });
  return trainedPromise;
}

interface DayPrediction {
  hours: { hour: number; congestion: number }[];
  bestHour: number;
  bestCongestion: number;
}

/** 오늘 24시간 예측 막대 — enabled 일 때만 불러온다(추천 시트는 그 장소에서 시트를 펼침까지 올린 뒤). 실패는 조용히 숨긴다. */
export function DayForecast({ facilityType, enabled }: { facilityType: string; enabled: boolean }) {
  const t = useT();
  const [pred, setPred] = useState<DayPrediction | null>(null);
  useEffect(() => {
    if (!enabled || !facilityType) return;
    let active = true;
    isPredictModelTrained()
      .then((trained) => (trained && active ? apiClient.get(`/predict/day?facilityType=${encodeURIComponent(facilityType)}`) : null))
      .then((res) => {
        const r = res as DayPrediction | null;
        if (active && r?.hours?.length === 24) setPred(r);
      })
      .catch(() => active && setPred(null));
    return () => {
      active = false;
    };
  }, [enabled, facilityType]);
  if (!pred) return null;
  const hour = (h: number) => {
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return h < 12 ? t('card.hourAm', { h: h12 }) : t('card.hourPm', { h: h12 });
  };
  return (
    <View className="border-t border-line pt-[12px]">
      <View className="mb-[8px] flex-row items-center gap-[6px]">
        <Icon icon={Clock} size="xs" color="gold-deep" />
        <Text className="text-[12px] leading-[16px]" weight="bold">{t('card.todayForecast')}</Text>
      </View>
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={t('card.forecastAria', { time: hour(pred.bestHour) })}
        className="h-[40px] flex-row items-end gap-[2px]"
      >
        {pred.hours.map((h) => (
          <View key={h.hour} className="h-full flex-1 justify-end">
            <View
              style={{
                height: `${Math.max(8, Math.round(h.congestion * 100))}%`,
                backgroundColor: h.hour === pred.bestHour ? colors.jade : 'rgba(184, 150, 90, 0.35)',
                borderRadius: 2,
              }}
            />
          </View>
        ))}
      </View>
      <View className="mt-[4px] flex-row justify-between" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {[0, 6, 12, 18, 23].map((h) => (
          <Text key={h} className="text-[10px] leading-[13px] text-muk-soft">{t('card.oClock', { h })}</Text>
        ))}
      </View>
      <View className="mt-[8px] flex-row items-center gap-[4px]">
        <Icon icon={Sparkles} size="xs" color="jade" />
        <Text className="text-[12px] leading-[16px] text-jade" weight="bold">{t('card.bestTime', { time: hour(pred.bestHour) })}</Text>
      </View>
    </View>
  );
}

