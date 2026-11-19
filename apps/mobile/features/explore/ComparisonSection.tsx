// '순서 자세히' — 웹 components/RecommendationComparison.tsx(기준 커밋 0d145a1).
// 웹과 같은 가로 표(min-w 520 — 폭이 좁으면 옆으로 민다, G4a-26).
import { BarChart3, Sparkles, X } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { Icon, Text } from '~/components/ui';
import { Pressable } from '~/components/ui/Pressable';
import { explainRecommendation, type RecommendationQuestion, type RecommendationResponse } from '~/lib/core/apiClient';
import { spotPoints } from '~/lib/core/spotPoints';
import { useI18n } from '~/lib/i18n/I18nProvider';
import { track } from '~/lib/platform/analytics';
import { congestionKey } from '@/lib/congestionScale';

import { isSyntheticRecommendationId } from './logic';
import { congestionDisplay, isBaselinePrediction } from './port/congestionEstimate';
import { buildSpotComparisons, formatSpotComparison, type SpotComparisonCandidate } from './port/spotComparison';
import { displayWalkingMinutes } from './port/walking';

const QUESTIONS = ['why_first', 'difference', 'family_check'] as const;
/** 웹 표 min-w-[520px] · 이름표 칸 약 84(나머지를 장소 수로 나눈다 — 3곳이면 약 145). */
const TABLE_WIDTH = 520;
const LABEL_COL = 84;

/** 상위 3곳의 SPOT 비교 입력 — 대안 카드의 '비교 한 줄'도 같은 함수로 만든다. */
export function toComparisonCandidates(recommendations: readonly RecommendationResponse[]): SpotComparisonCandidate[] {
  return recommendations.slice(0, 3).map((item, index) => ({
    id: item.recommendationId,
    rank: item.rank ?? index + 1,
    preference: item.breakdown.preference ?? 0,
    travelMinutes:
      typeof item.breakdown.travelTime === 'number'
        ? item.breakdown.travelTime
        : displayWalkingMinutes(undefined, item.distanceM),
    scoringMode: item.scoringMode,
    rankingWaitMinutes: item.breakdown.rankingWaitTime ?? item.breakdown.waitTime,
    areaDemandPenaltyMinutes: item.breakdown.areaDemandPenaltyMinutes,
    areaDemandParkingEvidence: item.breakdown.areaDemandParkingEvidence,
    areaDemandTourismEvidence: item.breakdown.areaDemandTourismEvidence,
    couponRate: item.facility.couponRate,
  }));
}

export function ComparisonSection({
  recommendations,
  busyAt,
}: {
  recommendations: readonly RecommendationResponse[];
  busyAt: number;
}) {
  const { t, locale } = useI18n();
  const top = recommendations.slice(0, 3);
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState<{ text: string; labels: string[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const comparisonById = useMemo(
    () => new Map(buildSpotComparisons(toComparisonCandidates(top)).map((c) => [c.id, c])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [recommendations],
  );
  if (top.length < 2) return null;
  const canExplain = top.every((item) => !isSyntheticRecommendationId(item.recommendationId));

  const ask = async (question: RecommendationQuestion) => {
    setBusy(true);
    try {
      const comparisonIds = question === 'difference' ? [top[1].recommendationId] : [];
      const result = await explainRecommendation(top[0].recommendationId, question, comparisonIds, locale);
      setAnswer({ text: result.answer, labels: result.sourceLabels });
      track('recommendation_explained', { question, llm_status: result.llmStatus });
    } catch {
      setAnswer({ text: t('compare.explainFailed'), labels: [] });
      track('recommendation_explained', { question, llm_status: 'llm_failed' });
    } finally {
      setBusy(false);
    }
  };

  const cards = (
    <View className="gap-[8px]">
      {top.map((item, index) => {
        const comparison = comparisonById.get(item.recommendationId);
        if (!comparison) return null;
        return (
          <View
            key={item.recommendationId}
            className="flex-row items-start gap-[12px] rounded-xl border border-jade/15 bg-white/80 px-[12px] py-[10px]"
          >
            <View className="h-[24px] w-[24px] shrink-0 items-center justify-center rounded-full bg-jade">
              <Text className="text-[11px] font-extrabold text-white">{index + 1}</Text>
            </View>
            <View className="min-w-0 flex-1">
              <Text className="text-xs font-extrabold text-muk" numberOfLines={1}>
                {item.facility.name}
              </Text>
              <Text className="mt-[2px] text-[11px] leading-[15.125px] text-muk-soft">{formatSpotComparison(t, comparison)}</Text>
            </View>
          </View>
        );
      })}
    </View>
  );

  if (!open) {
    return (
      <View className="mb-[16px] rounded-2xl border border-jade/25 bg-jade/5 p-[16px]">
        <View className="mb-[12px] flex-row items-center gap-[8px]">
          <Icon icon={BarChart3} size={16} color="jade" />
          <Text className="text-sm font-extrabold text-muk" accessibilityRole="header">
            {t('recommend.spotComparison.title')}
          </Text>
        </View>
        {cards}
        <Text className="mt-[8px] text-[10px] leading-[16.25px] text-muk-soft">{t('recommend.spotComparison.basis')}</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            setOpen(true);
            track('recommendation_compared', { count: top.length });
          }}
          hitSlop={{ top: 4, bottom: 4 }}
          className="mt-[12px] flex-row items-center justify-center gap-[8px] rounded-xl border border-gold/30 bg-gold/10 py-[10px]"
        >
          <Icon icon={BarChart3} size={14} color="gold-deep" />
          <Text className="text-xs text-gold-deep" weight="bold">{t('compare.open')}</Text>
        </Pressable>
      </View>
    );
  }

  const congestionText = (r: RecommendationResponse): string => {
    const display = congestionDisplay(r);
    if (display.mode === 'estimated' && display.estimate) {
      return t('card.estimateLevel', { label: t(`congestion.${congestionKey(display.estimate.level, busyAt)}`) });
    }
    if (display.mode === 'predicted' && display.level != null && isBaselinePrediction(r)) {
      return t('card.baselineLevel', { label: t(`congestion.${congestionKey(display.level, busyAt)}`) });
    }
    return display.level == null ? '—' : `${Math.round(display.level * 100)}%`;
  };
  const rows: { label: string; values: string[] }[] = [
    { label: t('compare.spot'), values: top.map((r) => `${spotPoints(r.spotScore)}`) },
    { label: t('compare.preference'), values: top.map((r) => `${Math.round((r.breakdown.preference ?? 0) * 100)}%`) },
    {
      label: t('compare.walkWait'),
      values: top.map((r) => {
        const walk = t('recommend.minutesValue', { n: displayWalkingMinutes(r.breakdown.travelTime, r.distanceM) });
        return r.breakdown.waitTime == null
          ? walk
          : `${walk} · ${t('recommend.minutesValue', { n: Math.round(r.breakdown.waitTime) })}`;
      }),
    },
    { label: t('compare.congestion'), values: top.map(congestionText) },
    {
      label: t('compare.openStatus'),
      values: top.map((r) =>
        r.openStatusAtArrival && r.openStatusAtArrival !== 'needs_confirmation'
          ? t(`card.arrivalStatus.${r.openStatusAtArrival}`)
          : '—',
      ),
    },
    {
      label: t('compare.coupon'),
      values: top.map((r) => (r.facility.couponRate ? `${Math.round(r.facility.couponRate * 100)}%` : '—')),
    },
  ];

  const colWidth = (TABLE_WIDTH - LABEL_COL) / top.length;

  return (
    <View className="mb-[16px] overflow-hidden rounded-2xl border border-line bg-white p-[16px]">
      <View className="mb-[12px] flex-row items-center justify-between">
        <Text className="text-[16px] text-muk" weight="bold" accessibilityRole="header">
          {t('compare.title')}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}
          onPress={() => setOpen(false)}
          hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
        >
          <Icon icon={X} size={17} color="muk" />
        </Pressable>
      </View>
      <View className="mb-[16px] rounded-xl bg-jade/5 p-[12px]">
        <Text className="mb-[8px] text-xs font-extrabold text-muk">{t('recommend.spotComparison.title')}</Text>
        {cards}
        <Text className="mt-[8px] text-[10px] leading-[16.25px] text-muk-soft">{t('recommend.spotComparison.basis')}</Text>
      </View>
      <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={false}>
        <View style={{ width: TABLE_WIDTH }}>
          <View className="flex-row">
            <View style={{ width: LABEL_COL }} className="justify-center py-[8px]">
              <Text className="text-xs" weight="bold">
                {t('compare.metric')}
              </Text>
            </View>
            {top.map((item, vi) => (
              <View key={item.recommendationId} style={{ width: colWidth }} className="justify-center px-[8px]">
                <Text className="text-center text-xs" weight="bold">
                  {`${item.rank ?? vi + 1}. ${item.facility.name}`}
                </Text>
              </View>
            ))}
          </View>
          {rows.map((row) => (
            <View key={row.label} className="flex-row border-t border-line">
              <View style={{ width: LABEL_COL }} className="justify-center py-[8px]">
                <Text className="text-xs text-muk-soft" weight="semibold">
                  {row.label}
                </Text>
              </View>
              {row.values.map((value, vi) => (
                <View key={`${row.label}-${vi}`} style={{ width: colWidth }} className="justify-center px-[8px] py-[8px]">
                  <Text className="text-center text-xs text-muk" weight="semibold">
                    {value}
                  </Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
      {canExplain ? (
        <View className="mt-[16px] flex-row flex-wrap gap-[8px]">
          {QUESTIONS.map((q) => (
            <Pressable
              key={q}
              accessibilityRole="button"
              disabled={busy}
              onPress={() => void ask(q)}
              hitSlop={{ top: 7, bottom: 7 }}
              className={`flex-row items-center gap-[4px] rounded-full border border-jade/30 bg-jade/10 px-[12px] py-[6px] ${busy ? 'opacity-50' : ''}`}
            >
              <Icon icon={Sparkles} size={12} color="jade" />
              <Text className="text-xs text-jade" weight="bold">
                {t(`compare.question.${q}`)}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {answer ? (
        <View className="mt-[12px] rounded-xl bg-hanji-deep p-[12px]" accessibilityLiveRegion="polite">
          <Text className="text-xs leading-[19.5px] text-muk">{answer.text}</Text>
          <View className="mt-[8px] flex-row flex-wrap gap-[4px]">
            {answer.labels.map((label) => (
              <View key={label} className="rounded bg-white px-[6px] py-[2px]">
                <Text className="text-[9px] text-muk-soft">{label}</Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}
