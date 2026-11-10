// 나의 여행 임팩트 — 웹 app/mypage/impact/page.tsx. 타일은 근거가 있는 값만(출발·도착 확인은 센 값이라 0 도 그림, 나머지는 0 보다 클 때만).
// 기록이 없거나 비로그인·서버 미가용이면 시작 상태(지도로 가는 버튼) — 숫자를 지어내지 않는다. 지역 전환(S3)은 앱 v1 이 경주만이라 뺐다.
import { useRouter } from 'expo-router';
import { Clock, Compass, MapPin, Share2, Sparkles, Ticket, Wind, type LucideIcon } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { View } from 'react-native';

import { Button, Card, EmptyState, Icon, Screen, Skeleton, Text, toast } from '~/components/ui';
import { shareLink, WEB_ORIGIN } from '~/lib/platform/share';

import { useT } from '~/lib/i18n/I18nProvider';
import type { ColorToken } from '~/lib/theme/tokens';

import { fetchImpactSummary } from '~/features/mypage/api';
import { impactMetrics } from '~/features/mypage/components/ImpactSummaryCard';
import { useRemote } from '~/features/mypage/useRemote';

const fmt = (n: number) => n.toLocaleString();

export default function ImpactScreen() {
  const t = useT();
  const router = useRouter();
  // 첫 실패는 세션 부트스트랩 경합일 수 있어 2.5초 뒤 한 번 더. 그래도 실패·401 이면 시작 상태.
  const { state, data: summary } = useRemote(fetchImpactSummary);
  const empty = state === 'failed' || state === 'unauthenticated' || (state === 'ok' && !summary?.hasRecord);

  const onShare = async () => {
    if (!summary) return;
    const message = summary.arrivalsConfirmed !== null
      ? t('impact.shareText', { departures: fmt(summary.accepted), arrivals: fmt(summary.arrivalsConfirmed) })
      : t('impact.shareTextDepartures', { departures: fmt(summary.accepted) });
    const outcome = await shareLink({ title: t('impact.shareTitle'), message, url: WEB_ORIGIN });
    if (outcome === 'copied') toast.success(t('impact.shareCopied'));
    else if (outcome === 'failed') toast.error(t('impact.shareCopyFail'));
  };

  return (
    <Screen scroll edges={['left', 'right']} contentClassName="px-[16px] py-[16px] gap-[16px]">
      {state === 'loading' ? (
        <Card className="gap-[16px]" accessible accessibilityLabel={t('common.loading')} accessibilityState={{ busy: true }}>
          <Skeleton width="25%" height={12} style={{ alignSelf: 'center' }} />
          <Skeleton width="66%" height={24} style={{ alignSelf: 'center' }} />
          <View className="flex-row flex-wrap gap-[12px]">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} width="47%" height={96} radius={16} />)}
          </View>
        </Card>
      ) : empty || !summary ? (
        <EmptyState
          icon={Sparkles}
          title={t('impact.emptyTitle')}
          description={t('impact.emptyBody')}
          action={{ label: t('impact.emptyCta'), onPress: () => router.navigate('/') }}
        />
      ) : (
        <>
          <Card className="border-gold/35 bg-gold/10" padded={false} style={{ padding: 20 }}>
            <View className="flex-row items-center gap-[6px]">
              <Icon icon={Sparkles} size="md" color="gold-deep" />
              <Text className="text-[13px]" weight="bold">{t('impact.summaryTitle')}</Text>
            </View>
            <View className="mt-[12px] flex-row flex-wrap gap-[8px]">
              {impactMetrics(t, summary).map((text) => (
                <View key={text} className="min-w-[45%] flex-1 rounded-2xl border border-line bg-white/70 px-[8px] py-[10px]">
                  <Text className="text-center text-[13px]" weight="black">{text}</Text>
                </View>
              ))}
            </View>
            <Text className="mt-[8px] text-[11px] leading-[17px] text-muk-soft">{t('impact.summaryRealNote')}</Text>
          </Card>

          <Card className="items-center border-gold/30" elevation="surface" padded={false} style={{ padding: 24 }}>
            <Text className="mb-[8px] text-xs uppercase tracking-[2px] text-gold-deep" weight="semibold">NextSpot</Text>
            <Text className="mb-[4px] text-center text-2xl" weight="bold" accessibilityRole="header">{t('impact.cardTitle')}</Text>
            <Text className="mb-[20px] text-center text-xs text-muk-soft">{t('impact.cardSubtitle')}</Text>
            <View className="mb-[20px] w-full flex-row flex-wrap gap-[12px]">
              <Tile icon={Compass} tone="terracotta" value={t('impact.tileTimesValue', { n: fmt(summary.accepted) })} label={t('impact.metricDepartures')} />
              {summary.arrivalsConfirmed !== null ? (
                <Tile icon={MapPin} tone="jade" value={t('impact.tileTimesValue', { n: fmt(summary.arrivalsConfirmed) })} label={t('impact.metricArrivals')} />
              ) : null}
              {summary.congestionAvoided > 0 ? (
                <Tile icon={Wind} tone="jade" value={t('impact.tileTimesValue', { n: fmt(summary.congestionAvoided) })} label={t('impact.metricCongestionAvoided')} />
              ) : null}
              {summary.couponsIssued > 0 ? (
                <Tile
                  icon={Ticket}
                  tone="gold-deep"
                  value={t('impact.tileCouponsIssuedValue', { n: fmt(summary.couponsIssued) })}
                  label={
                    summary.couponsUsed > 0
                      ? `${t('impact.metricCouponsIssued')} · ${t('impact.metricCouponsUsedInline', { n: fmt(summary.couponsUsed) })}`
                      : t('impact.metricCouponsIssued')
                  }
                />
              ) : null}
              {summary.waitSavedMinutes > 0 ? (
                <Tile icon={Clock} tone="muk-soft" value={t('impact.tileWaitSavedValue', { n: fmt(summary.waitSavedMinutes) })} label={t('impact.metricWaitSaved')} />
              ) : null}
            </View>
            <Text className="text-center text-[11px] leading-[17px] text-muk-soft">{t('impact.countNote')}</Text>
          </Card>

          <Button label={t('impact.shareButton')} icon={Share2} block onPress={() => { void onShare(); }} />
        </>
      )}
    </Screen>
  );
}

function Tile({ icon, tone, value, label }: { icon: LucideIcon; tone: ColorToken; value: string; label: ReactNode }) {
  return (
    <View
      className="min-w-[44%] flex-1 items-center gap-[6px] rounded-2xl border border-line bg-hanji p-[16px]"
      accessible
      accessibilityLabel={`${typeof label === 'string' ? label : ''} ${value}`.trim()}
    >
      <Icon icon={icon} size="lg" color={tone} />
      <Text className="text-center text-xl" weight="bold">{value}</Text>
      <Text className="text-center text-[11px] text-muk-soft" weight="medium">{label}</Text>
    </View>
  );
}
