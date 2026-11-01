// 대기 보드 탭 — '지금 출발하면?'. 웹 apps/web/app/waiting/page.tsx 의 앱판.
// 유형별 섹터(식당·카페·관광지·문화시설)마다 도착 시점 예상 대기가 짧은 순 상위 3곳을 대표 카드로, 나머지는 행으로 보여 준다.
// 카드를 누르면 그 장소 둘레의 같은 종류 대안(/explore/recommend). 알림(한산해지면 알려 주기)은 앱 v1 에 없다.
import { useRouter, type Href } from 'expo-router';
import { useCallback } from 'react';
import { View } from 'react-native';

import { EmptyState, ErrorState, Screen, Text } from '~/components/ui';
import { useBusyThreshold } from '~/lib/core/publicSettings';
import { useT } from '~/lib/i18n/I18nProvider';
import { BoardSkeleton, SectorSkeleton } from '~/features/waiting/BoardSkeleton';
import type { BoardRow } from '~/features/waiting/boardData';
import { computeBoardView } from '~/features/waiting/boardView';
import { NowChip } from '~/features/waiting/NowChip';
import { buildRecommendRoute } from '~/features/waiting/recommendHref';
import { SectorBoard } from '~/features/waiting/SectorBoard';
import { useWaitingBoard } from '~/features/waiting/useWaitingBoard';

const TAB_EDGES = ['top', 'left', 'right'] as const;

export default function WaitingScreen() {
  const t = useT();
  const router = useRouter();
  const busyAt = useBusyThreshold();
  const { sectors, partial, loading, failed, retry, estimateLevels, waitOf } = useWaitingBoard();

  const open = useCallback(
    (row: BoardRow) => router.push(buildRecommendRoute(row) as unknown as Href),
    [router],
  );

  const shown = loading ? partial : sectors;
  const view = computeBoardView(shown, loading ? null : sectors, waitOf, estimateLevels, busyAt);
  const { crowd, bestWait } = view;
  const uniform = crowd.spread.uniform;

  const body = (() => {
    if (loading && !partial?.length) return <BoardSkeleton label={t('common.loading')} />;
    if (failed) return <ErrorState message={t('waiting.fetchError')} retryLabel={t('common.retry')} onRetry={retry} />;
    if (!shown || shown.length === 0) {
      return (
        <EmptyState
          emoji="🗺️"
          title={t('waiting.emptyTitle')}
          description={t('waiting.emptyBody')}
          action={{ label: t('waiting.emptyCta'), onPress: () => router.navigate('/') }}
        />
      );
    }
    return (
      <View className="gap-[24px]" accessibilityState={{ busy: loading }}>
        {shown.map((sector) => (
          <SectorBoard
            key={sector.type}
            sector={sector}
            waitOf={waitOf}
            estimateLevels={estimateLevels}
            displayOf={view.displayOf}
            committed={!loading}
            onOpen={open}
          />
        ))}
        {loading ? <SectorSkeleton /> : null}
      </View>
    );
  })();

  return (
    <Screen edges={TAB_EDGES} scroll contentClassName="px-[16px] pb-[24px] pt-[16px]">
      <View className="gap-[16px]">
        <View className="gap-[12px] rounded-2xl border border-line/70 bg-hanji-deep/45 p-[16px]">
          <View className="flex-row flex-wrap items-center gap-[8px]">
            <View className="self-start rounded-full border border-gold/30 bg-gold/15 px-[10px] py-[4px]">
              <Text className="text-[11px] text-gold-deep" weight="bold">
                {t('waiting.brand')}
              </Text>
            </View>
            <NowChip />
          </View>
          <View className="gap-[6px]">
            <Text className="text-[22px] leading-[26px]" weight="black" accessibilityRole="header">
              {t('waiting.title')}
            </Text>
            <Text className="text-[13px] leading-[19px] text-muk-soft">
              {uniform ? t('waiting.subtitleUniform') : view.showsAnyCalmLine ? t('waiting.subtitle') : t('waiting.subtitleArrival')}
            </Text>
            <Text className="text-[11px] leading-[16px] text-muk-soft">
              {uniform ? t(crowd.legendUniformKey) : view.showsAnyCalmLine ? t('wait.legend') : t('wait.legendArrival')}
            </Text>
          </View>
          {bestWait !== null ? (
            <View className="flex-row flex-wrap items-center gap-[8px]">
              <View className="flex-row items-center gap-[6px] rounded-xl border border-gold/40 bg-gold/15 px-[12px] py-[8px]">
                <Text className="text-[13px]" accessibilityElementsHidden importantForAccessibility="no">
                  ⏱️
                </Text>
                <Text className="text-[13px] text-gold-deep" weight="black">
                  {t('waiting.heroBestWait', { n: bestWait.minutes })}
                </Text>
                {bestWait.estimated ? (
                  <View className="rounded-md border border-line bg-white/70 px-[6px] py-[2px]">
                    <Text className="text-[11px] text-muk-soft" weight="bold">
                      {t('wait.estimatedTag')}
                    </Text>
                  </View>
                ) : null}
              </View>
            </View>
          ) : null}
        </View>

        <Text className="px-[4px] text-[11px] leading-[16px] text-muk-soft">{t('waiting.dataAttribution')}</Text>

        {crowd.areaLine && crowd.spread.grade ? (
          <View className="flex-row items-center gap-[8px] px-[4px]">
            <View
              className={`h-[10px] w-[10px] rounded-full ${
                crowd.spread.grade === 'busy' ? 'bg-terracotta' : crowd.spread.grade === 'moderate' ? 'bg-gold' : 'bg-jade'
              }`}
              accessibilityElementsHidden
              importantForAccessibility="no"
            />
            <Text className="flex-1 text-[14px]" weight="bold">
              {t('wait.areaNow', { label: t(`congestion.${crowd.spread.grade}`) }) +
                (view.sharedCalmHour !== null ? ` · ${t('wait.calmAt', { h: view.sharedCalmHour })}` : '')}
            </Text>
          </View>
        ) : null}

        {body}
      </View>
    </Screen>
  );
}
