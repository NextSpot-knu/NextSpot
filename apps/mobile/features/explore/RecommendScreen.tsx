// /explore/recommend 화면 — 웹 apps/web/app/explore/recommend/page.tsx 의 RecommendContent(기준 커밋 0d145a1).
// 빼고 옮긴 것은 PORTING.md 와 docs/MOBILE_APP_PLAN.md §3.1: 음성 비서(🎙)·온보딩 모달·자연어 선호 입력은 앱에 없다.
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft, ChevronDown, Compass } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { View, useWindowDimensions } from 'react-native';

import { Button, EmptyState, ErrorState, Icon, IconButton, Screen, Skeleton, Text } from '~/components/ui';
import { Pressable } from '~/components/ui/Pressable';
import { apiClient } from '~/lib/core/apiClient';
import { countKey, useI18n } from '~/lib/i18n/I18nProvider';
import { boardCrowdSpread } from '@/lib/boardOrder';

import { AlternativeCard } from './AlternativeCard';
import { ComparisonSection, toComparisonCandidates } from './ComparisonSection';
import {
  headerTitleSpec,
  originPillTone,
  originSubject,
  type HeaderTitleSpec,
} from './logic';
import { hasOrigin, parseRecommendParams, showsOtherKinds } from './origin';
import { congestionDisplay } from './port/congestionEstimate';
import { buildSpotComparisons, formatSpotComparison } from './port/spotComparison';
import { useAlternatives } from './useAlternatives';
import { useRecommendLocation } from './useRecommendLocation';

/** 이 폭(pt) 이상(펼친 Z Fold·태블릿)이면 카드를 두 줄로 나란히 — 웹 lg:grid-cols-2. */
const TWO_COLUMN_MIN_WIDTH = 720;
const WIDE_MAX_WIDTH = 960;

export default function RecommendScreen() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const raw = useLocalSearchParams();
  const { width } = useWindowDimensions();
  const params = useMemo(
    () => parseRecommendParams(raw as Record<string, string | string[] | undefined>),
    // 값이 바뀔 때만 새로 읽는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(raw)],
  );
  const originOk = hasOrigin(params);

  // 고를 장소가 없으면(깨진 공유 링크) 빈 화면 대신 지도로 — 뒤로 가기에 이 빈 화면이 남지 않게 replace.
  useEffect(() => {
    if (!originOk) router.replace('/');
  }, [originOk, router]);

  // 공유 유입 계측 — 공유 링크(ref=share)로 들어온 방문을 한 번 기록한다(실패는 조용히).
  useEffect(() => {
    if (params.fromShare && originOk) {
      apiClient.post('/api/v1/events/track', { event: 'share_visit', props: { ref: 'share' } }).catch(() => {});
    }
    // 처음 한 번만.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const location = useRecommendLocation(params, t);
  const data = useAlternatives({
    params,
    coords: location.coords,
    locationReady: location.ready,
    isUserLocation: location.isUserLocation,
    t,
  });
  const {
    origin,
    recommendations,
    loading,
    loadFailed,
    noAlternatives,
    originGrade,
    busyAt,
  } = data;

  const [orderOpen, setOrderOpen] = useState(false);

  const comparisonById = useMemo(
    () =>
      new Map(
        buildSpotComparisons(toComparisonCandidates(recommendations)).map((c) => [c.id, formatSpotComparison(t, c)]),
      ),
    [recommendations, t],
  );
  const tastePeers = useMemo(
    () => recommendations.map((rec) => Math.round((rec.breakdown?.preference || 0) * 100)),
    [recommendations],
  );
  const altSpread = useMemo(
    () =>
      boardCrowdSpread(
        recommendations
          .map((rec) => congestionDisplay(rec).estimate?.level)
          .filter((level): level is number => typeof level === 'number'),
        busyAt,
      ),
    [recommendations, busyAt],
  );

  const originName = origin?.name ?? null;
  const titleSpec = headerTitleSpec({
    originName,
    noAlternatives,
    walkFromPlace: params.walkFromPlace,
    loading,
    count: recommendations.length,
  });
  const title = titleText(t, titleSpec);
  const pillTone = originName ? originPillTone(originGrade) : null;
  const otherKindsShown = !loading && showsOtherKinds(data.candidateTypes, recommendations);
  const twoColumns = width >= TWO_COLUMN_MIN_WIDTH;
  const goMap = () => router.replace('/');

  const stackOptions = (
    <Stack.Screen
      options={{
        title: '',
        headerShadowVisible: false,
        // 공유 링크로 바로 열려 돌아갈 화면이 없으면 지도로 보내는 버튼을 둔다.
        headerLeft: router.canGoBack()
          ? undefined
          : () => (
              <IconButton
                icon={ArrowLeft}
                accessibilityLabel={t('recommend.backToMap')}
                box={44}
                onPress={goMap}
              />
            ),
      }}
    />
  );

  if (!originOk) {
    return (
      <>
        {stackOptions}
        <Screen edges={['left', 'right']} maxWidth={WIDE_MAX_WIDTH} contentClassName="px-[16px] py-[16px]">
          <Skeleton height={120} radius={16} />
        </Screen>
      </>
    );
  }

  return (
    <>
      {stackOptions}
      <Screen
        scroll
        edges={['left', 'right', 'bottom']}
        maxWidth={WIDE_MAX_WIDTH}
        contentClassName="gap-[20px] px-[16px] pb-[32px] pt-[8px]"
      >
        {/* 머리글 한 덩어리 — 브랜드 칩 → 제목 → 원래 장소의 붐빔 알약 → 한 줄 가치 */}
        <View className="gap-[10px] rounded-2xl border border-line/70 bg-hanji-deep/45 p-[16px]">
          <View className="self-start rounded-full border border-gold/30 bg-gold/15 px-[10px] py-[4px]">
            <Text className="text-[11px] font-bold text-gold-deep">{t('recommend.headerBrand')}</Text>
          </View>
          {data.loadingOriginal ? (
            <View className="gap-[8px]" accessibilityLabel={t('recommend.preparing')} accessibilityState={{ busy: true }}>
              <Skeleton width="75%" height={28} />
              <Skeleton width="50%" height={16} />
            </View>
          ) : (
            <Text className="text-[22px] font-black leading-[27px] text-muk" accessibilityRole="header">
              {title}
            </Text>
          )}
          {originName && pillTone ? (
            <View
              testID="recommend-origin-pill"
              className={`flex-row flex-wrap items-center gap-[6px] self-start rounded-full border px-[12px] py-[4px] ${
                pillTone === 'busy' ? 'border-terracotta/30 bg-terracotta/10' : 'border-jade/30 bg-jade/10'
              }`}
            >
              <View
                className={`h-[8px] w-[8px] rounded-full ${pillTone === 'busy' ? 'bg-terracotta' : 'bg-jade'}`}
                accessibilityElementsHidden
                importantForAccessibility="no"
              />
              <Text className={`text-[13px] font-bold ${pillTone === 'busy' ? 'text-terracotta' : 'text-jade'}`}>
                {t(pillTone === 'busy' ? 'recommend.originBusy' : 'recommend.originCalm', {
                  subject: originSubject(originName, locale),
                })}
                {originGrade?.estimated ? <Text className="font-semibold">{` · ${t('wait.estimatedTag')}`}</Text> : null}
              </Text>
            </View>
          ) : null}
          {!noAlternatives ? (
            <Text className="text-[13px] leading-[20px] text-muk-soft">{t('recommend.heroDesc')}</Text>
          ) : null}
        </View>

        {/* 데이터 출처 — 머리글 바로 아래(긴 목록의 맨 끝이면 아무도 못 본다). */}
        <Text className="-mt-[8px] px-[4px] text-[11px] leading-[17px] text-muk-soft">{t('recommend.dataAttribution')}</Text>

        {otherKindsShown ? (
          <Text
            testID="recommend-kind-fallback"
            className="rounded-xl border border-gold/30 bg-gold/10 px-[12px] py-[8px] text-[13px] font-semibold leading-[18px] text-muk"
          >
            {t('recommend.otherKindsNotice')}
          </Text>
        ) : null}

        {/* 대안들이 모두 같은 추정 등급이면 그 등급을 한 번만 */}
        {!pillTone && altSpread.uniform && altSpread.grade && !loading && recommendations.length > 0 ? (
          <View testID="recommend-area-line" className="flex-row items-center gap-[8px] px-[4px]">
            <View
              className={`h-[10px] w-[10px] rounded-full ${
                altSpread.grade === 'busy' ? 'bg-terracotta' : altSpread.grade === 'moderate' ? 'bg-gold' : 'bg-jade'
              }`}
              accessibilityElementsHidden
              importantForAccessibility="no"
            />
            <Text className="min-w-0 flex-1 text-[14px] font-bold text-muk">
              {t('wait.areaNow', { label: t(`congestion.${altSpread.grade}`) })}
            </Text>
          </View>
        ) : null}

        {/* 대안 카드 목록 */}
        <View className="flex-row flex-wrap gap-[16px]" accessibilityLiveRegion="polite">
          {loading ? (
            [1, 2, 3].map((i) => (
              <View
                key={i}
                className="gap-[12px] rounded-2xl border border-line bg-white p-[16px]"
                style={twoColumns ? { width: '48.5%' } : { width: '100%' }}
                accessibilityLabel={t('recommend.preparing')}
                accessibilityState={{ busy: true }}
              >
                <Skeleton height={144} radius={12} />
                <Skeleton width="66%" height={20} />
                <View className="flex-row gap-[8px]">
                  <Skeleton width={80} height={28} radius={9999} />
                  <Skeleton width={96} height={28} radius={9999} />
                </View>
                <Skeleton height={44} radius={12} />
              </View>
            ))
          ) : recommendations.length > 0 ? (
            recommendations.map((rec, idx) => (
              <AlternativeCard
                key={rec.recommendationId}
                rec={rec}
                index={idx}
                busyAt={busyAt}
                originGrade={originGrade}
                tastePeers={tastePeers}
                spotComparison={comparisonById.get(rec.recommendationId)}
                vote={data.feedbackVotes[rec.recommendationId]}
                hoursOpen={data.hoursPrompt?.recommendationId === rec.recommendationId}
                hoursSubmitting={data.hoursSubmitting}
                hoursSubmitError={data.hoursSubmitError}
                widthPct={twoColumns ? 48.5 : 100}
                onAccept={data.requestAccept}
                onVote={data.handleSatisfactionFeedback}
                onShare={data.handleShare}
                onHoursAnswer={data.submitHoursStatus}
                onHoursDismiss={data.dismissHoursPrompt}
              />
            ))
          ) : loadFailed ? (
            // 실패는 '없음' 이 아니다 — 다시 시도할 길을 준다.
            <View className="w-full">
              <ErrorState message={t('recommend.loadFailed')} onRetry={data.retry} retryLabel={t('common.retry')} />
            </View>
          ) : (
            // 대안 0곳 — '없어요' 상자 대신 바로 할 수 있는 다음 행동(지도에서 다른 곳 고르기).
            <View testID="recommend-empty-next" className="w-full">
              <EmptyState
                emoji="🧭"
                title={t('recommend.emptyNext')}
                action={{ label: t('recommend.exploreMap'), onPress: goMap }}
              />
            </View>
          )}
        </View>

        {/* 다른 대안 보기 */}
        {recommendations.length > 0 ? (
          <Button
            variant="secondary"
            block
            label={data.refreshing ? t('recommend.loadingMore') : `🔄 ${t('recommend.seeOther')}`}
            loading={data.refreshing}
            disabled={data.refreshing}
            onPress={() => void data.handleRefresh()}
          />
        ) : null}

        {/* 순서 근거 — 목록 아래, 원할 때만 */}
        {!loading && recommendations.length >= 2 ? (
          <View className="gap-[12px]">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('recommend.orderDetails')}
              accessibilityState={{ expanded: orderOpen }}
              onPress={() => setOrderOpen((open) => !open)}
              className="min-h-[44px] flex-row items-center gap-[4px] self-start rounded-full px-[8px]"
            >
              <Text className="text-[12px] font-bold text-muk-soft">{t('recommend.orderDetails')}</Text>
              <View style={{ transform: [{ rotate: orderOpen ? '180deg' : '0deg' }] }}>
                <Icon icon={ChevronDown} size="xs" color="muk-soft" />
              </View>
            </Pressable>
            {orderOpen ? <ComparisonSection recommendations={recommendations} busyAt={busyAt} /> : null}
          </View>
        ) : null}
      </Screen>
    </>
  );
}

function titleText(t: (key: string, vars?: Record<string, string | number>) => string, spec: HeaderTitleSpec): string {
  switch (spec.key) {
    case 'recommend.heroTitle':
      return t('recommend.heroTitle');
    case 'literal':
      return spec.text;
    case 'recommend.headerInstead':
      return t(countKey('recommend.headerInstead', spec.count), spec.vars);
    default:
      return t(spec.key, spec.vars);
  }
}
