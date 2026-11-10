import { Clock, Sparkles } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { GoldenHourBadge } from '~/components/GoldenHourBadge';
import { Icon, Text } from '~/components/ui';
import { apiClient } from '~/lib/core/apiClient';
import { colors } from '~/lib/theme/tokens';

import { useT } from '~/lib/i18n/I18nProvider';

/**
 * 골든타임 — 카드·저장·대기가 같이 쓰는 components/GoldenHourBadge 하나(§4.3). 웹처럼 '추천 근거 자세히'를 연 동안만
 * 마운트한다(마운트 = 호출, G3-18). enabled 가 false 면 그리지도 부르지도 않는다(옛 시트 호출부 호환).
 */
export function GoldenHourLine({ facilityId, enabled = true }: { facilityId: string; enabled?: boolean }) {
  if (!enabled) return null;
  return <GoldenHourBadge facilityId={facilityId} />;
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
    setPred(null);
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
  // 웹 RecommendationCard '최적 방문 시각' — 제목 11px · 막대 금 35%(rounded-sm 4px) · 눈금 10px muk-soft 70% · 최저 시각 11px(G3-18).
  return (
    <View className="border-t border-line/70 pt-[12px]">
      <View className="mb-[8px] flex-row items-center gap-[6px]">
        <Icon icon={Clock} size={13} color="gold-deep" />
        <Text className="text-[11px] leading-[16.5px]" weight="bold">{t('card.todayForecast')}</Text>
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
                backgroundColor: h.hour === pred.bestHour ? colors.jade : 'rgba(193, 154, 62, 0.35)',
                borderRadius: 4,
              }}
            />
          </View>
        ))}
      </View>
      <View className="mt-[4px] flex-row justify-between" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {[0, 6, 12, 18, 23].map((h) => (
          <Text key={h} className="text-[10px] leading-[15px] text-muk-soft/70" weight="medium">{t('card.oClock', { h })}</Text>
        ))}
      </View>
      <View className="mt-[8px] flex-row items-center gap-[4px]">
        <Icon icon={Sparkles} size={11} color="jade" />
        <Text className="text-[11px] leading-[16.5px] text-jade" weight="bold">{t('card.bestTime', { time: hour(pred.bestHour) })}</Text>
      </View>
    </View>
  );
}
