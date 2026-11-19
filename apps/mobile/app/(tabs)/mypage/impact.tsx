// 나의 여행 임팩트 — 웹 app/mypage/impact/page.tsx. 타일은 근거가 있는 값만(출발·도착 확인은 센 값이라 0 도 그림, 나머지는 0 보다 클 때만).
// 기록이 없거나 비로그인·서버 미가용이면 시작 상태(지도로 가는 버튼) — 숫자를 지어내지 않는다. 지역 전환(S3)은 앱 v1 이 경주만이라 뺐다.
// 지표·타일은 두 개씩 줄 + flex-1(웹 grid-cols-2, 홀수 마지막 칸은 반 폭 — G5b-23).
import { useRouter } from 'expo-router';
import { Clock, Compass, MapPin, Share2, Sparkles, Ticket, Wind, type LucideIcon } from 'lucide-react-native';
import { Children, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { Button, Card, Glow, Gradient, Icon, Skeleton, Text, toast } from '~/components/ui';
import { shareLink, WEB_ORIGIN } from '~/lib/platform/share';

import { useT } from '~/lib/i18n/I18nProvider';
import { colors, type ColorToken } from '~/lib/theme/tokens';

import { fetchImpactSummary } from '~/features/mypage/api';
import { impactMetrics } from '~/features/mypage/components/ImpactSummaryCard';
import { SubScreen } from '~/features/mypage/components/parts';
import { useRemote } from '~/features/mypage/useRemote';

const fmt = (n: number) => n.toLocaleString();

/** 웹 shadow-[0_8px_32px_rgba(43,35,32,0.10)] — tokens 에 이름이 없다(요청 목록). */
const SURFACE_SHADOW = '0px 8px 32px rgba(43, 35, 32, 0.10)';

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
    <SubScreen gap={0}>
      {state === 'loading' ? (
        <Card
          padded={false}
          className="rounded-3xl"
          style={{ padding: 32 }}
          accessible
          accessibilityLabel={t('common.loading')}
          accessibilityState={{ busy: true }}
        >
          <Skeleton width="25%" height={12} style={{ alignSelf: 'center', marginBottom: 16 }} />
          <Skeleton width="66%" height={24} style={{ alignSelf: 'center', marginBottom: 32 }} />
          <Rows gap={12} style={{ marginBottom: 24 }}>
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} height={96} radius={16} />)}
          </Rows>
          <Skeleton width="50%" height={16} style={{ alignSelf: 'center' }} />
        </Card>
      ) : empty || !summary ? (
        <Card
          padded={false}
          className="w-full items-center rounded-3xl border-gold/30"
          style={{ padding: 32, boxShadow: SURFACE_SHADOW }}
        >
          <View className="mb-[20px] h-[56px] w-[56px] items-center justify-center rounded-2xl bg-gold/15">
            <Icon icon={Sparkles} size={26} color="gold-deep" />
          </View>
          <Text className="text-center text-xl leading-[27.5px]" weight="bold" accessibilityRole="header">{t('impact.emptyTitle')}</Text>
          <Text className="mt-[8px] text-center text-sm leading-[22.75px] text-muk-soft">{t('impact.emptyBody')}</Text>
          <Button
            className="mt-[24px]"
            block
            variant="gold"
            size={56}
            labelSize={16}
            labelWeight="semibold"
            iconSize={18}
            icon={Compass}
            label={t('impact.emptyCta')}
            onPress={() => router.navigate('/')}
          />
        </Card>
      ) : (
        <>
          <Card padded={false} className="mb-[16px] overflow-hidden rounded-3xl border-gold/35 bg-hanji" style={{ padding: 20 }}>
            <Gradient name="impactCard" style={StyleSheet.absoluteFill} pointerEvents="none" />
            <View className="flex-row items-center gap-[6px] self-start">
              <Icon icon={Sparkles} size={16} color="gold-deep" />
              <Text className="text-[13px]" weight="bold">{t('impact.summaryTitle')}</Text>
            </View>
            <Rows gap={8} style={{ marginTop: 12 }}>
              {impactMetrics(t, summary).map((text) => (
                <View key={text} className="rounded-2xl border border-line bg-white/70 px-[8px] py-[10px]">
                  <Text className="text-center text-[13px] leading-[19.5px]" weight="black" style={{ fontVariant: ['tabular-nums'] }}>{text}</Text>
                </View>
              ))}
            </Rows>
            <Text className="mt-[8px] text-[11px] leading-[17.9px] text-muk-soft">{t('impact.summaryRealNote')}</Text>
          </Card>

          <Card padded={false} className="overflow-hidden rounded-3xl border-gold/30" style={{ padding: 32, boxShadow: SURFACE_SHADOW }}>
            {/* 웹 광원(-top-10 -right-10 w-40 h-40 bg-gold/15 blur-[60px]) + 능선 실루엣(장식) */}
            <Glow color="gold" opacity={0.15} size={160} blur={60} position={{ top: -40, right: -40 }} />
            <View
              pointerEvents="none"
              style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 64 }}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              <Svg width="100%" height={64} viewBox="0 0 400 100" preserveAspectRatio="xMidYMax slice">
                <Path d="M-20 100 Q 80 30 180 100 Z" fill={colors.jade} fillOpacity={0.08} />
                <Path d="M140 100 Q 260 15 380 100 Z" fill={colors.jade} fillOpacity={0.08} />
                <Path d="M-40 100 Q 40 45 130 100 Z" fill={colors.jade} fillOpacity={0.13} />
                <Path d="M250 100 Q 340 35 440 100 Z" fill={colors.jade} fillOpacity={0.13} />
              </Svg>
            </View>
            <View className="items-center">
              <Text className="mb-[8px] text-xs uppercase tracking-[1.2px] text-gold-deep" weight="semibold">NextSpot</Text>
              <Text className="mb-[4px] text-center text-2xl" weight="bold" accessibilityRole="header">{t('impact.cardTitle')}</Text>
              <Text className="mb-[24px] text-center text-xs text-muk-soft">{t('impact.cardSubtitle')}</Text>
              <Rows gap={12} style={{ marginBottom: 24, width: '100%' }}>
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
              </Rows>
              <Text className="text-center text-[11px] leading-[17.9px] text-muk-soft">{t('impact.countNote')}</Text>
            </View>
          </Card>

          <Button
            className="mt-[24px]"
            block
            variant="gold"
            size={56}
            labelSize={16}
            labelWeight="semibold"
            iconSize={18}
            icon={Share2}
            label={t('impact.shareButton')}
            onPress={() => { void onShare(); }}
          />
        </>
      )}
    </SubScreen>
  );
}

/** 두 개씩 줄 + 칸 flex-1. 48% 폭은 반올림으로 둘째 칸이 내려가므로 쓰지 않는다(R3 G5b-23). 홀수 마지막 줄은 빈 칸으로 반 폭. */
function Rows({ children, gap, style }: { children: ReactNode; gap: number; style?: object }) {
  const items = Children.toArray(children).filter(Boolean);
  const rows: ReactNode[][] = [];
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
  return (
    <View style={[{ gap }, style]}>
      {rows.map((row, r) => (
        <View key={r} className="flex-row" style={{ gap }}>
          {row.map((c, i) => <View key={i} className="min-w-0 flex-1">{c}</View>)}
          {row.length === 1 ? <View className="flex-1" /> : null}
        </View>
      ))}
    </View>
  );
}

function Tile({ icon, tone, value, label }: { icon: LucideIcon; tone: ColorToken; value: string; label: ReactNode }) {
  return (
    <View
      className="w-full items-center gap-[6px] rounded-2xl border border-line bg-hanji p-[16px]"
      accessible
      accessibilityLabel={`${typeof label === 'string' ? label : ''} ${value}`.trim()}
    >
      <Icon icon={icon} size={20} color={tone} />
      <Text className="w-full text-center text-xl" weight="bold">{value}</Text>
      <Text className="w-full text-center text-[11px] text-muk-soft" weight="medium">{label}</Text>
    </View>
  );
}
