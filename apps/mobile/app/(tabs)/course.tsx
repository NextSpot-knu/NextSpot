// 분산 코스(/course) — 웹 apps/web/app/course/page.tsx 이식(기준 커밋 0d145a1).
// 폰: 한 ScrollView 안에 지도(38% 높이)와 흰 시트가 함께 스크롤된다(웹은 문서 스크롤). 시트가 지도 아래 24 를 덮되, **실제 지도가 그려진 동안만**
// 지도가 시트 윗부분 위에 온다(웹 렌더 결과 — 카카오 내부 층이 시트 위에 칠해진다. 구글·카카오 로고가 시트 밑에 숨지 않는다, 약관).
// 폭이 600pt 이상(Z Fold 펼침·태블릿)이면 지도와 판을 좌우로 나눈다.
// 상태·요청은 features/course 의 훅이 맡고, 이 파일은 짜 맞추기만 한다.
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, View, useWindowDimensions } from 'react-native';
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AssumedTimeSelect, useAssumedPreset } from '~/components/AssumedTimeSelect';
import { ShareButton } from '~/components/ShareButton';
import { useNavInsets } from '~/components/navigation/navMetrics';
import { ErrorState, Pressable, Text } from '~/components/ui';
import { BackCircleButton } from '~/components/ui/BackCircleButton';
import { LoadingReveal } from '~/components/ui/LoadingReveal';
import { NowChip } from '~/components/ui/NowChip';
import { useReduceMotion } from '~/components/ui/useReduceMotion';
import { CourseMapView } from '~/features/course/components/CourseMapView';
import {
  AuthState,
  CourseGantt,
  CourseStepper,
  DimmedResult,
  EmptyCourse,
  SharedBanner,
  ViewToggle,
  type ViewMode,
} from '~/features/course/components/CourseSections';
import { OrderPicker } from '~/features/course/components/OrderPicker';
import { RotatingChevron } from '~/features/course/components/RotatingChevron';
import { StopRows } from '~/features/course/components/StopRows';
import { hhmm } from '~/features/course/model';
import { useCourseLocation } from '~/features/course/useCourseLocation';
import { useCoursePlan } from '~/features/course/useCoursePlan';
import { useSharedCourse } from '~/features/course/useSharedCourse';
import { assumedAtIsoForPreset } from '~/lib/core/assumedTime';
import { useT } from '~/lib/i18n/I18nProvider';
import { WEB_ORIGIN, courseShareUrl, reshareCourseUrl, shareLink } from '~/lib/platform/share';

/** 폭이 이 이상이면 지도와 판을 좌우로 나눈다(펼친 Z Fold7 ≈ 600dp 이상). */
const SPLIT_MIN_WIDTH = 600;
/** 웹 시트 `-mt-6` — 시트가 지도 아래로 겹치는 높이(내비 막대 치수가 아니다). */
const SHEET_OVERLAP = 24;
/** 웹 지도 38dvh · 지도 폴백 22dvh. */
const MAP_HEIGHT_RATIO = 0.38;
const MAP_FALLBACK_HEIGHT_RATIO = 0.22;
const SHEET_SHADOW = '0px -8px 30px rgba(43, 35, 32, 0.12)';

type MapState = 'loading' | 'live' | 'unavailable';

/** 지도 자리표시 — 웹 `bg-hanji-deep animate-pulse`(2초 주기 1 → .5 → 1). */
function MapPlaceholder({ height }: { height: number | '100%' }) {
  const reduceMotion = useReduceMotion();
  const o = useSharedValue(1);
  useEffect(() => {
    if (reduceMotion) {
      o.value = 1;
      return undefined;
    }
    const ease = Easing.bezier(0.4, 0, 0.6, 1);
    o.value = withRepeat(withSequence(withTiming(0.5, { duration: 1000, easing: ease }), withTiming(1, { duration: 1000, easing: ease })), -1);
    return () => cancelAnimation(o);
  }, [o, reduceMotion]);
  const style = useAnimatedStyle(() => ({ opacity: o.value }));
  return <Animated.View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" className="w-full bg-hanji-deep" style={[{ height }, style]} />;
}

export default function CourseScreen() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const nav = useNavInsets();
  const { width, height } = useWindowDimensions();
  const split = width >= SPLIT_MIN_WIDTH;
  const { s } = useLocalSearchParams<{ s?: string | string[] }>();
  const shareParam = (Array.isArray(s) ? s[0] : s) ?? null;

  const coords = useCourseLocation();
  const shared = useSharedCourse(shareParam);
  const plan = useCoursePlan(coords, !shared.isShareMode);
  const [viewMode, setViewMode] = useState<ViewMode>('cards');
  const [builderOpen, setBuilderOpen] = useState(false);
  const [mapState, setMapState] = useState<MapState>('loading');
  const scrollRef = useRef<ScrollView>(null);

  const isShare = shared.isShareMode;
  const stops = isShare ? shared.stops : plan.stops;
  const loading = isShare ? shared.loading : plan.loading;
  const error = isShare ? shared.error : plan.error;
  const lastStop = stops.length > 0 ? stops[stops.length - 1] : null;

  // 도착 시각의 기준 — 가정 시간 코스는 그 시각부터, 공유 코스는 지금부터(오프셋을 공유 뒤 경과 분으로 이미 보정했다).
  const assumedPreset = useAssumedPreset();
  const baseMs = useMemo(() => {
    if (isShare) return null;
    const iso = assumedAtIsoForPreset(assumedPreset);
    return iso ? Date.parse(iso) : null;
  }, [isShare, assumedPreset]);

  const shareUrl = useMemo(() => {
    // 공유받은 코스는 원본 링크를 그대로 넘긴다 — 다시 인코딩하면 새 공유 시각이 찍혀 '지금 바로 도착' 인 거짓 일정이 된다.
    const url = isShare
      ? reshareCourseUrl(shareParam)
      : courseShareUrl(
          stops.map((st) => ({ id: st.facility.id, offsetMin: st.arrivalOffsetMin, congestion: st.predictedCongestion })),
        );
    // 정류지가 없어도(오류·빈 상태) 공유 버튼은 보이고, 그때는 코스 페이지 주소를 공유한다(웹 ShareButton:28).
    return url ?? `${WEB_ORIGIN}/course`;
  }, [isShare, shareParam, stops]);

  // 결과별 토스트(복사 ✓ 2초·실패 10초)는 ShareButton 이 띄운다 — 여기서는 공유만.
  const onShare = useCallback(
    () => shareLink({ title: t('course.title'), message: t('common.shareCourse'), url: shareUrl }),
    [shareUrl, t],
  );

  const goMap = () => router.navigate('/');
  const newCourse = () => router.replace('/course');

  // 탭을 떠날 때 화면 상태를 처음으로(웹은 탭 이동마다 새로 마운트된다 — D16 a). resetInputs 는 이미 비었으면 아무것도 바꾸지 않아 재조회가 나가지 않는다.
  const resetRef = useRef(plan.resetInputs);
  resetRef.current = plan.resetInputs;
  useFocusEffect(
    useCallback(
      () => () => {
        setViewMode('cards');
        setBuilderOpen(false);
        scrollRef.current?.scrollTo({ y: 0, animated: false });
        resetRef.current();
      },
      [],
    ),
  );

  const firstLoad = loading && !(isShare ? false : plan.hasLoadedOnce);
  // 첫 로딩에는 지도가 없다 — 다시 붙는 지도는 준비될 때까지 '지도 있음'으로 치지 않는다.
  useEffect(() => {
    if (firstLoad) setMapState('loading');
  }, [firstLoad]);
  const mapLive = !firstLoad && mapState === 'live';
  const phoneMapHeight = Math.round(height * (mapState === 'unavailable' ? MAP_FALLBACK_HEIGHT_RATIO : MAP_HEIGHT_RATIO));
  const mapHeight = split ? '100%' : phoneMapHeight;

  // 지도 + 떠 있는 버튼(뒤로·공유). 첫 로딩에는 지도·버튼 없이 자리표시만(웹 :857-859).
  const map = firstLoad ? (
    <View style={split ? { flex: 1 } : undefined}>
      <MapPlaceholder height={split ? '100%' : Math.round(height * MAP_HEIGHT_RATIO)} />
    </View>
  ) : (
    <View style={[split ? { flex: 1 } : undefined, { zIndex: mapLive ? 1 : 0 }]}>
      <CourseMapView
        stops={stops}
        userLocation={coords}
        height={mapHeight}
        onUnavailable={() => setMapState('unavailable')}
        onLive={() => setMapState('live')}
      />
      <BackCircleButton
        accessibilityLabel={t('course.backToMap')}
        accessibilityRole="link"
        floating
        onPress={goMap}
        style={{ position: 'absolute', top: 16, left: 16 }}
      />
      <View style={{ position: 'absolute', top: 16, right: 16 }}>
        <ShareButton onShare={onShare} url={shareUrl} floating />
      </View>
    </View>
  );

  const hasEta = stops.length > 0 && lastStop;

  const content = firstLoad ? (
    <LoadingReveal variant={isShare ? 'shared' : 'course'} />
  ) : (
    <>
      {isShare ? <SharedBanner elapsedMin={shared.elapsedMin} onNewCourse={newCourse} /> : null}

      <View className="gap-[12px] rounded-2xl border border-line/70 bg-hanji-deep/45 p-[16px]">
        <View className="flex-row flex-wrap items-center gap-[8px]">
          <View className="rounded-full border border-gold/30 bg-gold/15 px-[10px] py-[4px]">
            <Text className="text-[11px] leading-[16.5px] text-gold-deep" weight="bold">
              {t('course.brand')}
            </Text>
          </View>
          <NowChip />
        </View>
        {hasEta ? (
          <View className="gap-[6px]">
            {/* 웹 22px black leading-[1.15] tracking-tight(−0.025em → RN 은 px). */}
            <Text className="text-[22px] leading-[25.3px]" style={{ letterSpacing: -0.55 }} weight="black" accessibilityRole="header">
              {t('course.headline', { n: stops.length })}
            </Text>
            <Text className="text-[12px] leading-[19.5px] text-muk-soft">{t('course.subline')}</Text>
          </View>
        ) : (
          <View className="gap-[6px]">
            <Text className="text-[18px] leading-[22.5px]" style={{ letterSpacing: -0.45 }} weight="black" accessibilityRole="header">
              {t('course.title')}
            </Text>
            <Text className="text-[12px] leading-[19.5px] text-muk-soft">{t('course.desc')}</Text>
          </View>
        )}
        {/* 스탯 줄 — 도착 ETA(금 박스)와 가정 시간 컨트롤·배지. 공유 모드는 읽기 전용이라 컨트롤이 없다. */}
        {!isShare || hasEta ? (
          <View className="flex-row flex-wrap items-center gap-[8px] pt-[2px]">
            {hasEta && lastStop ? (
              <View
                className="flex-row items-center gap-[6px] self-start rounded-xl border border-gold/40 bg-gold/15 px-[12px] py-[8px]"
                style={{ boxShadow: '0px 2px 10px rgba(193, 154, 62, 0.16)' }}
              >
                <Text className="text-[13px] leading-[19.5px]" accessibilityElementsHidden importantForAccessibility="no">
                  🕒
                </Text>
                <Text className="text-[13px] leading-[19.5px] text-gold-deep" weight="black">
                  {t('course.headlineEta', { time: hhmm(lastStop.arrivalOffsetMin, baseMs) })}
                </Text>
              </View>
            ) : null}
            {!isShare ? <AssumedTimeSelect /> : null}
          </View>
        ) : null}
      </View>

      {stops.length > 0 ? <CourseStepper stops={stops} baseMs={baseMs} /> : null}

      {/* 고정을 비우는 마지막 탈출구 — 자동 모드에서 건 고정을 지울 경로가 화면에 하나도 없던 문제(웹). */}
      {!isShare && plan.sequence.length === 0 && Object.keys(plan.pins).length > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('course.unpinAll')}
          onPress={plan.unpinAll}
          className="min-h-[44px] self-start justify-center rounded-full border border-line bg-white px-[16px]"
        >
          <Text className="text-[12px] leading-[16px] text-muk-soft" weight="bold">
            📌 {t('course.unpinAll')}
          </Text>
        </Pressable>
      ) : null}

      {/* 결과 — 재조회 중에는 이전 결과를 유지한 채 흐리게만(순서 피커·지도가 사라지지 않는다). */}
      <DimmedResult busy={loading}>
        {!isShare && plan.needsAuth ? (
          <AuthState onGoMap={goMap} />
        ) : error ? (
          <ErrorState message={error} onRetry={isShare ? shared.reload : plan.retry} retryLabel={t('common.retry')} />
        ) : stops.length === 0 ? (
          <EmptyCourse outcomes={isShare ? [] : plan.slotOutcomes} onWidenTime={isShare ? undefined : plan.widenTimeAndReplan} />
        ) : (
          <View className="gap-[12px]">
            <ViewToggle mode={viewMode} onChange={setViewMode} />
            {viewMode === 'gantt' ? (
              <CourseGantt stops={stops} baseMs={baseMs} />
            ) : (
              <StopRows
                stops={stops}
                readOnly={isShare}
                outcomes={isShare ? [] : plan.slotOutcomes}
                pins={plan.pins}
                slotKeys={plan.renderedSlotKeys}
                slotsStale={plan.slotsStale}
                baseMs={baseMs}
                onTogglePin={plan.togglePin}
                onSwap={plan.swapTo}
                onUnpin={plan.unpinSlot}
              />
            )}
          </View>
        )}
      </DimmedResult>

      {!isShare ? (
        <View className="gap-[12px]">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('course.builderToggle')}
            accessibilityState={{ expanded: builderOpen }}
            onPress={() => setBuilderOpen((v) => !v)}
            className="min-h-[44px] flex-row items-center gap-[6px] self-start rounded-full border border-line bg-white px-[16px]"
          >
            <Text accessibilityElementsHidden importantForAccessibility="no" className="text-[13px] leading-[19.5px]">
              🧭
            </Text>
            <Text className="text-[13px] leading-[19.5px]" weight="bold">
              {t('course.builderToggle')}
            </Text>
            <RotatingChevron open={builderOpen} size={14} color="muk" />
          </Pressable>
          {builderOpen ? (
            <OrderPicker
              sequence={plan.sequence}
              onAdd={plan.addType}
              onRemove={plan.removeItem}
              onReorder={plan.reorder}
              onMove={plan.moveItem}
              onReset={plan.resetOrder}
              selectedTypes={plan.selectedTypes}
              onToggleType={plan.toggleType}
            />
          ) : null}
        </View>
      ) : null}

      <Text className="border-t border-line pt-[16px] text-center text-[11px] leading-[18px] text-muk-soft">
        {t('course.dataAttribution')}
      </Text>
    </>
  );

  const sheetInner = (
    <>
      {/* 손잡이 — 웹 w-12 h-1.5 rounded-full bg-line mt-3. 실제 지도가 있으면 지도 밑에 가려진다(웹 렌더 결과와 같다). */}
      <View className="mt-[12px] h-[6px] w-[48px] self-center rounded-full bg-line" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
      <View style={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: nav.gap, gap: firstLoad ? 24 : 20 }}>{content}</View>
    </>
  );

  return (
    <View className="flex-1 bg-hanji" style={{ paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }}>
      {split ? (
        <View className="flex-1 flex-row">
          {map}
          <ScrollView
            ref={scrollRef}
            style={{ width: Math.min(460, Math.round(width * 0.45)) }}
            contentContainerStyle={{ flexGrow: 1 }}
            className="rounded-t-3xl bg-white"
          >
            {sheetInner}
          </ScrollView>
        </View>
      ) : (
        <ScrollView ref={scrollRef} style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }}>
          {map}
          <View style={{ flexGrow: 1, marginTop: -SHEET_OVERLAP, boxShadow: SHEET_SHADOW }} className="rounded-t-3xl bg-white">
            {sheetInner}
          </View>
        </ScrollView>
      )}
    </View>
  );
}
