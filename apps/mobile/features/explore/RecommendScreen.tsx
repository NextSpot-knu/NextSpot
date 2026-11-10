// /explore/recommend 화면 — 웹 apps/web/app/explore/recommend/page.tsx 의 RecommendContent(기준 커밋 0d145a1).
// 빼고 옮긴 것은 PORTING.md 와 docs/MOBILE_APP_PLAN.md §3.1: 음성 비서(🎙, v1.1)·온보딩 모달·자연어 선호 입력은 앱에 없다.
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { ChevronDown } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, View, useWindowDimensions } from 'react-native';
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';

import { NAV_GAP } from '~/components/navigation/navMetrics';
import { useLeaveHiddenTab } from '~/components/navigation/useLeaveHiddenTab';
import { BackCircleButton } from '~/components/ui/BackCircleButton';
import { Button, ErrorState, Icon, Screen, Skeleton, Text, useReduceMotion } from '~/components/ui';
import { GlowPair } from '~/components/ui/Glow';
import { NowChip } from '~/components/ui/NowChip';
import { Pressable } from '~/components/ui/Pressable';
import { TrailingNoteText } from '~/components/ui/TrailingNoteText';
import { colors, shadows } from '~/lib/theme/tokens';
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
/** 웹 main `p-4` + 안쪽 `py-4` — 옆 16, 위 32. 아래는 웹 clearance 대신 NAV_GAP + 16(F1). */
const SIDE = 16;
const TOP = 32;
const EDGES = ['top', 'left', 'right'] as const;
/** 스켈레톤 사진 판 — 웹 bg-hanji-deep/60. */
const SKELETON_PHOTO = 'rgba(241, 231, 211, 0.6)';

/** 웹 animate-pulse(2초, 중간에 0.5) — 붐빔 점. 동작 줄이기에서는 멈춘다. */
function PulseDot({ color }: { color: string }) {
  const reduceMotion = useReduceMotion();
  const o = useSharedValue(1);
  useEffect(() => {
    if (reduceMotion) {
      o.value = 1;
      return;
    }
    o.value = withRepeat(withTiming(0.5, { duration: 1000 }), -1, true);
    return () => cancelAnimation(o);
  }, [reduceMotion, o]);
  const style = useAnimatedStyle(() => ({ opacity: o.value }));
  return (
    <Animated.View
      // Animated.View 는 className 을 받지 못한다 — 크기·색을 style 로.
      style={[{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }, style]}
      accessibilityElementsHidden
      importantForAccessibility="no"
    />
  );
}

export default function RecommendScreen() {
  const { t, locale } = useI18n();
  // 지도(홈)로 바꿔치기 — 탭 안 숨은 경로라 router.replace(탭에서는 JUMP_TO)를 쓰면 이 화면이 탭 기록에 남아
  // 뒤로 키가 빈 화면으로 돌아온다. 기록에서 이 경로를 빼고 홈으로 옮긴다(hiddenTabCore, B6 검토 M4).
  const leaveHiddenTab = useLeaveHiddenTab();
  const leaveToHome = useCallback(() => leaveHiddenTab('index'), [leaveHiddenTab]);
  const raw = useLocalSearchParams();
  const { width } = useWindowDimensions();
  const params = useMemo(
    () => parseRecommendParams(raw as Record<string, string | string[] | undefined>),
    // 값이 바뀔 때만 새로 읽는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(raw)],
  );
  const originOk = hasOrigin(params);

  // 고를 장소가 없으면(깨진 공유 링크) 빈 화면 대신 지도로 — 뒤로 가기에 이 빈 화면이 남지 않게 기록에서 뺀다.
  // 포커스 뒤에 보낸다 — 콜드 스타트 첫 마운트의 useEffect 에서 탭 상태를 reset 하면 내비게이터가 아직 준비 전이라 무시된다(웹 빌드 실측).
  useFocusEffect(
    useCallback(() => {
      if (!originOk) leaveToHome();
    }, [originOk, leaveToHome]),
  );

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
  const goMap = () => leaveToHome();

  // 스택 머리는 없다 — 이 화면은 탭 안 숨은 경로다(B6, G4a-15). 위 안전 영역은 화면이 비우고, 아래는 탭 막대가 맡는다.
  // 원형 '지도 보기' 버튼은 내용 안 첫 줄(스크롤과 함께 올라간다).
  if (!originOk) {
    return (
      <Screen edges={EDGES} maxWidth={WIDE_MAX_WIDTH} contentClassName="px-[16px] py-[16px]">
        <Skeleton height={120} radius={16} />
      </Screen>
    );
  }

  return (
    <Screen scroll edges={EDGES} maxWidth={WIDE_MAX_WIDTH} contentClassName="">
      {/* 웹 main(relative overflow-hidden)과 같다 — 광원은 내용과 함께 움직이고 가장자리에서 잘린다(G4a-14). 자르기는 루트가 아니라 광원 전용 absoluteFill 상자에 둔다(웹 빌드에서 루트 overflow-hidden 은 scrollIntoView 가 옆으로 밀게 한다). */}
      <View className="relative flex-1">
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { overflow: 'hidden' }]}>
          <GlowPair preset="alternative" />
        </View>
        <View className="gap-[20px]" style={{ paddingHorizontal: SIDE, paddingTop: TOP, paddingBottom: NAV_GAP + SIDE }}>
          <BackCircleButton accessibilityLabel={t('recommend.backToMap')} onPress={goMap} className="self-start" />

          {/* 머리글 한 덩어리 — 브랜드 칩 + 현재 시각 → 제목 → 원래 장소의 붐빔 알약 → 한 줄 가치 */}
          <View className="gap-[10px] rounded-2xl border border-line/70 bg-hanji-deep/45 p-[16px]">
            <View className="flex-row flex-wrap items-center gap-[8px]">
              <View className="self-start rounded-full border border-gold/30 bg-gold/15 px-[10px] py-[4px]">
                <Text className="text-[11px] font-bold text-gold-deep">{t('recommend.headerBrand')}</Text>
              </View>
              <NowChip />
            </View>
            {data.loadingOriginal ? (
              <View className="gap-[8px]" accessibilityLabel={t('recommend.preparing')} accessibilityState={{ busy: true }}>
                <Skeleton width="75%" height={28} />
                <Skeleton width="50%" height={16} />
              </View>
            ) : (
              <Text className="text-[22px] font-black leading-[26.4px] tracking-[-0.55px] text-muk" accessibilityRole="header">
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
                {pillTone === 'busy' ? (
                  <PulseDot color={colors.terracotta} />
                ) : (
                  <View className="h-[8px] w-[8px] rounded-full bg-jade" accessibilityElementsHidden importantForAccessibility="no" />
                )}
                <Text className={`text-[13px] font-bold ${pillTone === 'busy' ? 'text-terracotta' : 'text-jade'}`}>
                  {t(pillTone === 'busy' ? 'recommend.originBusy' : 'recommend.originCalm', {
                    subject: originSubject(originName, locale),
                  })}
                </Text>
                {originGrade?.estimated ? (
                  <Text className={`text-[13px] font-semibold opacity-80 ${pillTone === 'busy' ? 'text-terracotta' : 'text-jade'}`}>
                    {`· ${t('wait.estimatedTag')}`}
                  </Text>
                ) : null}
              </View>
            ) : null}
            {!noAlternatives ? (
              <Text className="text-[13px] leading-[21.125px] text-muk-soft">{t('recommend.heroDesc')}</Text>
            ) : null}
          </View>

          {/* 데이터 출처 — 머리글 바로 아래(긴 목록의 맨 끝이면 아무도 못 본다). */}
          <TrailingNoteText
            className="-mt-[8px] px-[4px] text-[11px] leading-[17.875px] text-muk-soft"
            text={t('recommend.dataAttribution')}
          />

          {otherKindsShown ? (
            <Text
              testID="recommend-kind-fallback"
              className="rounded-xl border border-gold/30 bg-gold/10 px-[12px] py-[8px] text-[13px] font-semibold leading-[17.875px] text-muk"
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
              <Text className="min-w-0 flex-1 text-sm font-bold text-muk">
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
                  className="gap-[12px] rounded-2xl border border-line bg-white p-[20px]"
                  style={[{ boxShadow: shadows.surface }, twoColumns ? { width: '48.5%' } : { width: '100%' }]}
                  accessibilityLabel={t('recommend.preparing')}
                  accessibilityState={{ busy: true }}
                >
                  <Skeleton height={144} radius={12} style={{ backgroundColor: SKELETON_PHOTO }} />
                  <Skeleton width="66%" height={20} />
                  <View className="flex-row gap-[8px]">
                    <Skeleton width={80} height={28} radius={9999} />
                    <Skeleton width={96} height={28} radius={9999} />
                  </View>
                  <Skeleton height={44} radius={12} style={{ marginTop: 4 }} />
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
                  shareUrl={data.shareUrl}
                  onAccept={data.requestAccept}
                  onVote={data.handleSatisfactionFeedback}
                  onShare={data.handleShare}
                  onReported={data.markReported}
                  onHoursAnswer={data.submitHoursStatus}
                  onHoursDismiss={data.dismissHoursPrompt}
                />
              ))
            ) : loadFailed ? (
              // 실패는 '없음' 이 아니다 — 다시 시도할 길을 준다(원래 장소부터 다시, 웹 reload 와 같은 범위).
              <View className="w-full">
                <ErrorState message={t('recommend.loadFailed')} onRetry={data.retry} retryLabel={t('common.retry')} />
              </View>
            ) : (
              // 대안 0곳 — '없어요' 상자 대신 바로 할 수 있는 다음 행동(지도에서 다른 곳 고르기). 웹 전용 블록(G4a-29).
              <View
                testID="recommend-empty-next"
                className="w-full items-center gap-[12px] rounded-2xl border border-line bg-white px-[20px] py-[24px]"
                style={{ boxShadow: shadows.surface }}
              >
                <Text className="text-center text-[15px]" weight="bold">
                  {t('recommend.emptyNext')}
                </Text>
                <Button label={`🧭 ${t('recommend.exploreMap')}`} labelSize={13} shape="full" paddingX={20} onPress={goMap} />
              </View>
            )}
          </View>

          {/* 다른 대안 보기 — 웹 pt-1 로 감싼다 */}
          {recommendations.length > 0 ? (
            <View className="pt-[4px]">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={data.refreshing ? t('recommend.loadingMore') : t('recommend.seeOther')}
                accessibilityState={{ disabled: data.refreshing, busy: data.refreshing }}
                disabled={data.refreshing}
                onPress={() => void data.handleRefresh()}
                className={`min-h-[44px] w-full flex-row items-center justify-center gap-[8px] rounded-xl border border-line bg-white py-[12px] ${
                  data.refreshing ? 'opacity-50' : ''
                }`}
                style={{ boxShadow: shadows.surface }}
              >
                {data.refreshing ? <ActivityIndicator size="small" color={colors['muk-soft']} /> : null}
                <Text className="text-center text-xs text-muk-soft" weight="semibold">
                  {data.refreshing ? t('recommend.loadingMore') : `🔄 ${t('recommend.seeOther')}`}
                </Text>
              </Pressable>
            </View>
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
                  <Icon icon={ChevronDown} size={13} color="muk-soft" />
                </View>
              </Pressable>
              {orderOpen ? <ComparisonSection recommendations={recommendations} busyAt={busyAt} /> : null}
            </View>
          ) : null}
        </View>
      </View>
    </Screen>
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
