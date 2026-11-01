// 분산 코스(/course) — 웹 apps/web/app/course/page.tsx 이식(기준 커밋 0d145a1).
// 지도(번호 원 + 점선) 위에 바텀시트 문법의 정보 판. 폭이 600pt 이상(Z Fold 펼침·태블릿)이면 지도와 판을 좌우로 나눈다.
// 상태·요청은 features/course 의 훅이 맡고, 이 파일은 짜 맞추기만 한다.
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronDown, Share2 } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ErrorState, Icon, IconButton, Pressable, Text, toast } from '~/components/ui';
import { CourseMapView } from '~/features/course/components/CourseMapView';
import {
  AuthState,
  CourseGantt,
  CourseSkeleton,
  CourseStepper,
  EmptyCourse,
  SharedBanner,
  ViewToggle,
  type ViewMode,
} from '~/features/course/components/CourseSections';
import { OrderPicker } from '~/features/course/components/OrderPicker';
import { StopRows } from '~/features/course/components/StopRows';
import { hhmm } from '~/features/course/model';
import { useCourseLocation } from '~/features/course/useCourseLocation';
import { useCoursePlan } from '~/features/course/useCoursePlan';
import { useSharedCourse } from '~/features/course/useSharedCourse';
import { useT } from '~/lib/i18n/I18nProvider';
import { haptic } from '~/lib/platform/haptics';
import { courseShareUrl, reshareCourseUrl, shareLink } from '~/lib/platform/share';

/** 폭이 이 이상이면 지도와 판을 좌우로 나눈다(펼친 Z Fold7 ≈ 600dp 이상). */
const SPLIT_MIN_WIDTH = 600;

/** 웹 NowChip — '현재 HH:MM 기준'. 도착 시각이 어느 시점 기준인지 밝힌다. */
function NowChip() {
  const t = useT();
  const [now, setNow] = useState(() => hhmm(0));
  useEffect(() => {
    const id = setInterval(() => setNow(hhmm(0)), 30_000);
    return () => clearInterval(id);
  }, []);
  return (
    <View className="rounded-full border border-line bg-hanji-deep/70 px-[8px] py-[3px]">
      <Text className="text-[11px] text-muk-soft" weight="medium">
        {t('common.nowTime', { time: now })}
      </Text>
    </View>
  );
}

export default function CourseScreen() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const split = width >= SPLIT_MIN_WIDTH;
  const { s } = useLocalSearchParams<{ s?: string | string[] }>();
  const shareParam = (Array.isArray(s) ? s[0] : s) ?? null;

  const coords = useCourseLocation();
  const shared = useSharedCourse(shareParam);
  const plan = useCoursePlan(coords, !shared.isShareMode);
  const [viewMode, setViewMode] = useState<ViewMode>('cards');
  const [builderOpen, setBuilderOpen] = useState(false);

  const isShare = shared.isShareMode;
  const stops = isShare ? shared.stops : plan.stops;
  const loading = isShare ? shared.loading : plan.loading;
  const error = isShare ? shared.error : plan.error;
  const lastStop = stops.length > 0 ? stops[stops.length - 1] : null;

  const shareUrl = useMemo(() => {
    // 공유받은 코스는 원본 링크를 그대로 넘긴다 — 다시 인코딩하면 새 공유 시각이 찍혀 '지금 바로 도착' 인 거짓 일정이 된다.
    if (isShare) return reshareCourseUrl(shareParam);
    return courseShareUrl(
      stops.map((st) => ({ id: st.facility.id, offsetMin: st.arrivalOffsetMin, congestion: st.predictedCongestion })),
    );
  }, [isShare, shareParam, stops]);

  const onShare = async () => {
    if (!shareUrl) return;
    haptic('selection');
    const outcome = await shareLink({ title: t('course.title'), message: t('common.shareCourse'), url: shareUrl });
    if (outcome === 'copied') toast.success(t('common.linkCopied'));
    else if (outcome === 'failed') toast.error(t('common.shareFailed'), { description: shareUrl });
  };

  const goMap = () => router.navigate('/');
  const newCourse = () => router.replace('/course');

  const firstLoad = loading && !(isShare ? false : plan.hasLoadedOnce);
  const mapHeight = split ? '100%' : Math.max(220, Math.round(height * 0.34));

  const map = (
    <View style={split ? { flex: 1 } : undefined}>
      <CourseMapView stops={stops} userLocation={coords} height={mapHeight} accessibilityLabel={t('course.stepperAria')} />
      {shareUrl ? (
        <View style={{ position: 'absolute', top: 12, right: 12 }}>
          <IconButton
            icon={Share2}
            accessibilityLabel={t('common.share')}
            onPress={onShare}
            box={44}
            className="border border-line bg-white/90"
          />
        </View>
      ) : null}
    </View>
  );

  const sheet = (
    <ScrollView
      style={split ? { width: Math.min(460, Math.round(width * 0.45)) } : { flex: 1 }}
      contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 24 + (split ? insets.bottom : 0), gap: 20 }}
      className="rounded-t-3xl bg-white"
    >
      {firstLoad ? (
        <CourseSkeleton mode={isShare ? 'shared' : 'course'} title={t(`loadingReveal.${isShare ? 'shared' : 'course'}.title`)} />
      ) : (
        <>
          {isShare ? <SharedBanner elapsedMin={shared.elapsedMin} onNewCourse={newCourse} /> : null}

          <View className="gap-[10px] rounded-2xl border border-line/70 bg-hanji-deep/45 p-[16px]">
            <View className="flex-row flex-wrap items-center gap-[8px]">
              <View className="rounded-full border border-gold/30 bg-gold/15 px-[10px] py-[4px]">
                <Text className="text-[11px] text-gold-deep" weight="bold">
                  {t('course.brand')}
                </Text>
              </View>
              <NowChip />
            </View>
            {stops.length > 0 && lastStop ? (
              <View className="gap-[6px]">
                <Text className="text-[22px] leading-[26px]" weight="black" accessibilityRole="header">
                  {t('course.headline', { n: stops.length })}
                </Text>
                <Text className="text-[12px] leading-[18px] text-muk-soft">{t('course.subline')}</Text>
                <View className="mt-[4px] self-start rounded-xl border border-gold/40 bg-gold/15 px-[12px] py-[8px]">
                  <Text className="text-[13px] text-gold-deep" weight="black">
                    🕒 {t('course.headlineEta', { time: hhmm(lastStop.arrivalOffsetMin) })}
                  </Text>
                </View>
              </View>
            ) : (
              <View className="gap-[6px]">
                <Text className="text-[18px] leading-[24px]" weight="black" accessibilityRole="header">
                  {t('course.title')}
                </Text>
                <Text className="text-[12px] leading-[18px] text-muk-soft">{t('course.desc')}</Text>
              </View>
            )}
          </View>

          {stops.length > 0 ? <CourseStepper stops={stops} baseMs={null} /> : null}

          {/* 고정을 비우는 마지막 탈출구 — 자동 모드에서 건 고정을 지울 경로가 화면에 하나도 없던 문제(웹). */}
          {!isShare && plan.sequence.length === 0 && Object.keys(plan.pins).length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('course.unpinAll')}
              onPress={plan.unpinAll}
              className="min-h-[44px] self-start justify-center rounded-full border border-line bg-white px-[16px]"
            >
              <Text className="text-[12px] text-muk-soft" weight="bold">
                📌 {t('course.unpinAll')}
              </Text>
            </Pressable>
          ) : null}

          {/* 결과 — 재조회 중에는 이전 결과를 유지한 채 흐리게만(순서 피커·지도가 사라지지 않는다). */}
          <View style={{ opacity: loading ? 0.5 : 1 }} pointerEvents={loading ? 'none' : 'auto'} accessibilityState={{ busy: loading }}>
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
                  <CourseGantt stops={stops} baseMs={null} />
                ) : (
                  <StopRows
                    stops={stops}
                    readOnly={isShare}
                    outcomes={isShare ? [] : plan.slotOutcomes}
                    pins={plan.pins}
                    slotKeys={plan.renderedSlotKeys}
                    slotsStale={plan.slotsStale}
                    onTogglePin={plan.togglePin}
                    onSwap={plan.swapTo}
                    onUnpin={plan.unpinSlot}
                  />
                )}
              </View>
            )}
          </View>

          {!isShare ? (
            <View className="gap-[12px]">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('course.builderToggle')}
                accessibilityState={{ expanded: builderOpen }}
                onPress={() => setBuilderOpen((v) => !v)}
                className="min-h-[44px] flex-row items-center gap-[6px] self-start rounded-full border border-line bg-white px-[16px]"
              >
                <Text accessibilityElementsHidden importantForAccessibility="no" className="text-[13px]">
                  🧭
                </Text>
                <Text className="text-[13px]" weight="bold">
                  {t('course.builderToggle')}
                </Text>
                <Icon icon={ChevronDown} size="xs" color="muk-soft" />
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

          <Text className="border-t border-line pt-[16px] text-center text-[11px] leading-[16px] text-muk-soft">
            {t('course.dataAttribution')}
          </Text>
        </>
      )}
    </ScrollView>
  );

  return (
    <View className="flex-1 bg-hanji" style={{ paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }}>
      {split ? (
        <View className="flex-1 flex-row">
          {map}
          {sheet}
        </View>
      ) : (
        <View className="flex-1">
          {map}
          <View style={{ flex: 1, marginTop: -24 }}>{sheet}</View>
        </View>
      )}
    </View>
  );
}
