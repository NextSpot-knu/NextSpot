// 나의 여행 임팩트 카드 — 웹 components/ImpactSummaryCard.tsx. 실제 기록이 있을 때만 그린다(조회 중·401·실패·기록 없음이면 아무것도).
// 숫자 규칙은 웹 순수 모듈 @/lib/impactSummary(readImpactSummary)를 그대로 쓴다.
import { useRouter } from 'expo-router';
import { ChevronRight, Sparkles } from 'lucide-react-native';
import { View } from 'react-native';

import { Card, Icon, Text } from '~/components/ui';
import type { ImpactSummary } from '@/lib/impactSummary';
import { useT } from '~/lib/i18n/I18nProvider';

/** 요약 문장들 — 값이 있는 조각만(도착 확인을 서버가 못 셌으면 빼고, 줄인 대기는 0 보다 클 때만). 임팩트 상세 화면도 같이 쓴다. */
export function impactMetrics(t: ReturnType<typeof useT>, summary: ImpactSummary): string[] {
  return [
    t('impact.summaryDepartures', { n: summary.accepted.toLocaleString() }),
    ...(summary.arrivalsConfirmed !== null ? [t('impact.summaryArrivals', { n: summary.arrivalsConfirmed.toLocaleString() })] : []),
    ...(summary.waitSavedMinutes > 0 ? [t('impact.summarySavedWait', { n: summary.waitSavedMinutes.toLocaleString() })] : []),
  ];
}

export function ImpactSummaryCard({ summary }: { summary: ImpactSummary | null }) {
  const t = useT();
  const router = useRouter();
  if (!summary?.hasRecord) return null;
  const metrics = impactMetrics(t, summary);
  return (
    <Card
      onPress={() => router.push('/mypage/impact' as never)}
      accessibilityLabel={`${t('impact.summaryAria')}. ${metrics.join(', ')}`}
      className="mb-[16px] border-gold/35 bg-gold/10"
      padded={false}
      style={{ padding: 20 }}
    >
      <View className="flex-row items-start justify-between gap-[12px]">
        <View className="min-w-0 flex-1">
          <View className="flex-row items-center gap-[6px]">
            <Icon icon={Sparkles} size="md" color="gold-deep" />
            <Text className="text-[13px]" weight="bold">{t('impact.summaryTitle')}</Text>
          </View>
          <View className="mt-[8px] flex-row flex-wrap items-baseline gap-x-[8px] gap-y-[4px]">
            {metrics.map((text, index) => (
              <View key={text} className="flex-row items-baseline gap-[8px]">
                {index > 0 ? <Text className="text-muk-soft" accessibilityElementsHidden>·</Text> : null}
                <Text className="text-[15px]" weight="black">{text}</Text>
              </View>
            ))}
          </View>
          <Text className="mt-[6px] text-[11px] leading-[17px] text-muk-soft">{t('impact.summaryRealNote')}</Text>
        </View>
        <View className="mt-[2px]"><Icon icon={ChevronRight} size="lg" color="gold-deep" /></View>
      </View>
    </Card>
  );
}
