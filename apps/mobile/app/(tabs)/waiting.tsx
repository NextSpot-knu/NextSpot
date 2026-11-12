// 대기 보드 탭 — '지금 출발하면?'. 웹 apps/web/app/waiting/page.tsx 의 앱판.
// 유형별 섹터(식당·카페·관광지·문화시설)마다 도착 시점 예상 대기가 짧은 순 상위 3곳을 대표 카드로, 나머지는 행으로 보여 준다.
// 카드를 누르면 그 장소 둘레의 같은 종류 대안(/explore/recommend). 골든타임 '알림 받기' 버튼은 F1(배지)이 더한다.
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { View } from 'react-native';

import { AssumedTimeSelect, useAssumedPreset } from '~/components/AssumedTimeSelect';
import { NAV_GAP } from '~/components/navigation/navMetrics';
import { BackCircleButton } from '~/components/ui/BackCircleButton';
import { GlowPair } from '~/components/ui/Glow';
import { LoadingReveal, WaitingSectorSkeleton } from '~/components/ui/LoadingReveal';
import { NowChip } from '~/components/ui/NowChip';
import { Screen } from '~/components/ui/Screen';
import { Text } from '~/components/ui/Text';
import { TrailingNoteText } from '~/components/ui/TrailingNoteText';
import { assumedPresetLabelKey } from '~/lib/core/assumedTime';
import { useBusyThreshold } from '~/lib/core/publicSettings';
import { useT } from '~/lib/i18n/I18nProvider';
import { BoardEmpty } from '~/features/waiting/BoardEmpty';
import { BoardError } from '~/features/waiting/BoardError';
import type { BoardRow } from '~/features/waiting/boardData';
import { computeBoardView } from '~/features/waiting/boardView';
import { buildRecommendRoute } from '~/features/waiting/recommendHref';
import { SectorBoard } from '~/features/waiting/SectorBoard';
import { useWaitingBoard } from '~/features/waiting/useWaitingBoard';

const TAB_EDGES = ['top', 'left', 'right'] as const;
// 웹 main 의 `p-4`(위·옆 16). 아래는 웹 clearance(116) 대신 탭 화면 안의 NAV_GAP(F1 — 막대는 흐름 밖이 아니라 화면 아래에 따로 있다).
const SIDE = 16;

export default function WaitingScreen() {
  const t = useT();
  const router = useRouter();
  const busyAt = useBusyThreshold();
  const preset = useAssumedPreset();
  const { sectors, partial, loading, failed, retry, estimateLevels, waitOf } = useWaitingBoard();

  // D16 ⓐ: 떠날 때 화면 상태(스크롤·캐러셀 위치)를 처음으로 — 웹은 라우트가 다시 마운트되며 모두 초기화된다.
  // 데이터(훅)는 이 바깥이라 그대로 두고, 화면 틀만 새로 연다. 돌아오면 캐시된 보드가 로더 없이 바로 보인다(ⓒ).
  const [visit, setVisit] = useState(0);
  useFocusEffect(
    useCallback(() => {
      return () => setVisit((v) => v + 1);
    }, []),
  );

  const open = useCallback(
    (row: BoardRow) => router.push(buildRecommendRoute(row) as unknown as Href),
    [router],
  );

  const shown = loading ? partial : sectors;
  const view = computeBoardView(shown, loading ? null : sectors, waitOf, estimateLevels, busyAt);
  const { crowd, bestWait } = view;
  const uniform = crowd.spread.uniform;

  const body = (() => {
    if (loading && !partial?.length) return <LoadingReveal variant="waiting" />;
    if (failed) return <BoardError message={t('waiting.fetchError')} retryLabel={t('common.retry')} onRetry={retry} />;
    if (!shown || shown.length === 0) {
      return (
        <BoardEmpty
          title={t('waiting.emptyTitle')}
          body={t('waiting.emptyBody')}
          ctaLabel={t('waiting.emptyCta')}
          onCta={() => router.navigate('/')}
        />
      );
    }
    return (
      <View className="gap-[24px]" aria-busy={loading}>
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
        {/* 아직 오는 섹션 자리 — 글자 없는 시머 한 판. */}
        {loading ? <WaitingSectorSkeleton /> : null}
      </View>
    );
  })();

  const presetLabel = t(assumedPresetLabelKey(preset));

  return (
    <Screen key={visit} edges={TAB_EDGES} scroll contentClassName="">
      {/* 웹 main(relative overflow-hidden)과 같다 — 노을·금빛 광원이 내용과 함께 움직이고 가장자리에서 잘린다(G5a-02). */}
      <View className="relative flex-1 overflow-hidden">
        <GlowPair preset="waiting" />
        <View className="gap-[20px]" style={{ paddingHorizontal: SIDE, paddingTop: SIDE, paddingBottom: NAV_GAP }}>
          <BackCircleButton accessibilityLabel={t('waiting.backAria')} className="self-start" />

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
              <Text
                className="text-[22px] leading-[25.3px]"
                style={{ letterSpacing: -0.55 }}
                weight="black"
                accessibilityRole="header"
              >
                {t('waiting.title')}
              </Text>
              <Text className="text-[13px] leading-[21.125px] text-muk-soft">
                {uniform ? t('waiting.subtitleUniform') : view.showsAnyCalmLine ? t('waiting.subtitle') : t('waiting.subtitleArrival')}
              </Text>
              {/* 카드가 무엇을 보여 주는지 한 줄로 먼저 말한다 — 한 등급이 아니어도 늘 그린다(G5a-06). */}
              <Text className="text-[11px] leading-[17.875px] text-muk-soft/90">
                {uniform ? t(crowd.legendUniformKey) : view.showsAnyCalmLine ? t('wait.legend') : t('wait.legendArrival')}
              </Text>
            </View>
            {/* 스탯 줄 — 최단 대기와 가정 시간 컨트롤이 한 줄에(웹 flex-wrap gap-2 pt-0.5). 컨트롤은 늘 있다. */}
            <View className="flex-row flex-wrap items-center gap-[8px] pt-[2px]">
              {bestWait !== null ? (
                <View
                  className="flex-row items-center gap-[6px] rounded-xl border border-gold/40 bg-gold/15 px-[12px] py-[8px]"
                  style={{ boxShadow: '0px 2px 10px rgba(193, 154, 62, 0.16)' }}
                >
                  <Text className="text-[13px]" accessibilityElementsHidden importantForAccessibility="no">
                    ⏱️
                  </Text>
                  <Text className="text-[13px] text-gold-deep" weight="black">
                    {t('waiting.heroBestWait', { n: bestWait.minutes })}
                  </Text>
                  {bestWait.estimated ? (
                    <View className="rounded-md border border-line bg-white/70 px-[6px] py-[2px]">
                      <Text className="text-[10px] text-muk-soft" weight="bold">
                        {t('wait.estimatedTag')}
                      </Text>
                    </View>
                  ) : null}
                </View>
              ) : null}
              <AssumedTimeSelect />
            </View>
          </View>

          {/* 데이터 출처 — 머리글 바로 아래(웹 -mt-2). 끝 괄호 덧붙임은 한 덩어리로(G5a-07). */}
          <TrailingNoteText
            text={t('waiting.dataAttribution')}
            className="px-[4px] text-[11px] leading-[17.875px] text-muk-soft"
            style={{ marginTop: -8 }}
          />

          {crowd.areaLine && crowd.spread.grade ? (
            <View className="flex-row items-center gap-[8px] px-[4px]">
              <View
                className={`h-[10px] w-[10px] rounded-full ${
                  crowd.spread.grade === 'busy' ? 'bg-terracotta' : crowd.spread.grade === 'moderate' ? 'bg-gold' : 'bg-jade'
                }`}
                accessibilityElementsHidden
                importantForAccessibility="no"
              />
              {/* 가정 시간으로 본 보드는 '지금' 이라고 말하지 않는다 — 그 시각 기준 한 줄(웹 wait.areaAt). */}
              <Text className="flex-1 text-[14px] leading-[20px]" weight="bold">
                {(preset === 'now'
                  ? t('wait.areaNow', { label: t(`congestion.${crowd.spread.grade}`) })
                  : t('wait.areaAt', { time: presetLabel, label: t(`congestion.${crowd.spread.grade}`) })) +
                  (view.sharedCalmHour !== null ? ` · ${t('wait.calmAt', { h: view.sharedCalmHour })}` : '')}
              </Text>
            </View>
          ) : null}

          {body}
        </View>
      </View>
    </Screen>
  );
}
