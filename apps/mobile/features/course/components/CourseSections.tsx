// 코스 화면의 덩어리들 — 웹 course/page.tsx 의 CourseStepper·ViewToggle·CourseGantt·SharedBanner·EmptyState·AuthState.
// (첫 로딩 스켈레톤은 공용 LoadingReveal variant course·shared 가 맡는다 — G4b-20.)
import { useEffect, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { Button, Gradient, Pressable, Text } from '~/components/ui';
import { useReduceMotion } from '~/components/ui/useReduceMotion';
import { useBusyThreshold } from '~/lib/core/publicSettings';
import { useT } from '~/lib/i18n/I18nProvider';
import { colors, shadows } from '~/lib/theme/tokens';
import { widenTimeBudget, loadTravelContext } from '../travelContext';

import { CONGESTION_CLASS, CONGESTION_TEXT_CLASS, congestionOf, stopEstimate } from '../congestionUi';
import { ganttLayout, hhmm, slotReasonKey, typeEmoji } from '../model';
import type { CourseStop, SlotOutcome } from '../types';
import { arrivalText } from './StopRows';

// ── 가로 스텝퍼 ──────────────────────────────────────────────────────────────

/** 정류지 순서 미리보기. 첫 칸은 내용 폭, 둘째부터 늘어나며 그 앞에 금빛 연결선이 선다(웹 :1103-1150). 이름은 두 줄까지, 첫 정류지만 강조. */
export function CourseStepper({ stops, baseMs }: { stops: CourseStop[]; baseMs: number | null }) {
  const t = useT();
  return (
    <View
      accessibilityRole="list"
      accessibilityLabel={t('course.stepperAria')}
      className="flex-row items-start rounded-2xl border border-line/60 bg-white px-[8px] py-[14px]"
      style={{ boxShadow: '0px 1px 2px rgba(43, 35, 32, 0.04)' }}
    >
      {stops.map((stop, idx) => {
        const first = idx === 0;
        const cell =
          idx > 0
            ? 'min-w-0 flex-1 flex-row items-start'
            : stops.length === 1
              ? 'min-w-0 flex-1 flex-row items-start justify-center'
              : 'min-w-0 flex-row items-start';
        return (
          <View key={stop.facility.id} role="listitem" className={cell}>
            {idx > 0 ? (
              <Gradient
                colors={['rgba(193, 154, 62, 0.2)', 'rgba(193, 154, 62, 0.4)', 'rgba(193, 154, 62, 0.2)']}
                start={{ x: 0, y: 0.5 }}
                end={{ x: 1, y: 0.5 }}
                pointerEvents="none"
                style={{ flex: 1, height: 3, borderRadius: 9999, marginTop: 18, marginHorizontal: 4 }}
              />
            ) : null}
            <View className="w-[88px] min-w-0 items-center gap-[6px]">
              {first ? (
                // 바깥 = 그림자, 안쪽 = 둥글게 자른 그라데이션 원(그림자와 overflow hidden 을 한 View 에 두면 그림자가 잘린다).
                <View
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                  style={{ width: 40, height: 40, borderRadius: 20, boxShadow: '0px 2px 10px rgba(193, 154, 62, 0.45)' }}
                >
                  <View style={{ flex: 1, borderRadius: 20, overflow: 'hidden', borderWidth: 2, borderColor: colors.white }}>
                    <Gradient
                      colors={[colors.gold, colors['gold-deep']]}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 1 }}
                      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
                    />
                    <View className="flex-1 items-center justify-center">
                      <Text className="text-[16px]">{typeEmoji(stop.facility.type)}</Text>
                    </View>
                  </View>
                </View>
              ) : (
                <View
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                  className="h-[40px] w-[40px] items-center justify-center rounded-full border-2 border-gold/25 bg-hanji-deep"
                >
                  <Text className="text-[16px]">{typeEmoji(stop.facility.type)}</Text>
                </View>
              )}
              <Text
                className={`text-center text-[12px] leading-[15px] ${first ? '' : 'text-muk-soft'}`}
                weight={first ? 'extrabold' : 'semibold'}
                numberOfLines={2}
              >
                {stop.facility.name}
              </Text>
              <View className={`rounded-full px-[6px] py-[2px] ${first ? 'bg-gold/15' : 'bg-hanji-deep'}`}>
                <Text className={`text-[10px] leading-[10px] ${first ? 'text-gold-deep' : 'text-muk-soft'}`} weight="bold">
                  {t('course.stepperOffset', { time: hhmm(stop.arrivalOffsetMin, baseMs) })}
                </Text>
              </View>
            </View>
          </View>
        );
      })}
    </View>
  );
}

// ── 목록 ↔ 시간표 전환 ───────────────────────────────────────────────────────

export type ViewMode = 'cards' | 'gantt';

export function ViewToggle({ mode, onChange }: { mode: ViewMode; onChange: (m: ViewMode) => void }) {
  const t = useT();
  const opts: { id: ViewMode; label: string }[] = [
    { id: 'cards', label: t('course.viewList') },
    { id: 'gantt', label: t('course.viewGantt') },
  ];
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={t('course.title')}
      className="flex-row gap-[4px] self-start rounded-full border border-line bg-white p-[4px]"
      style={{ boxShadow: '0px 1px 2px rgba(43, 35, 32, 0.04)' }}
    >
      {opts.map((o) => {
        const on = mode === o.id;
        return (
          <Pressable
            key={o.id}
            accessibilityRole="tab"
            accessibilityLabel={o.label}
            accessibilityState={{ selected: on }}
            onPress={() => onChange(o.id)}
            // 웹 min-h-9(36) — 44pt 탭 영역은 위아래 hitSlop 으로 채운다. 켜짐 바탕은 토큰 button-gold(결정 D2: 흰 글자 4.5:1 이상).
            hitSlop={{ top: 4, bottom: 4 }}
            className={`items-center justify-center rounded-full ${on ? 'bg-button-gold' : ''}`}
            style={{
              minHeight: 36,
              paddingHorizontal: 16,
              boxShadow: on ? '0px 2px 8px rgba(193, 154, 62, 0.3)' : undefined,
            }}
          >
            <Text className={`text-[12px] leading-[16px] ${on ? 'text-white' : 'text-muk-soft'}`} weight="bold">
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ── 간트(시간표) ─────────────────────────────────────────────────────────────

const TICK_BOX = 40;

/** 시간축에 정류지를 도착~다음 도착 구간 막대로 놓는다. 막대 색은 도착 시점 예측 혼잡 — 등급 단어만 말한다. 정확한 체류 시각은 서버가 주지 않아 도착 간격으로 근사한다. */
export function CourseGantt({ stops, baseMs }: { stops: CourseStop[]; baseMs: number | null }) {
  const t = useT();
  const busyAt = useBusyThreshold();
  const { segments, totalMin } = ganttLayout(stops);
  // 트랙 전체 폭 — 눈금 글자(가운데·오른쪽 맞춤)와 막대 폭(−2px)을 px 로 놓으려면 필요하다. 첫 프레임(0)에는 %로 대신한다.
  const [trackW, setTrackW] = useState(0);
  const ticks = Array.from({ length: 5 }, (_, i) => {
    const min = (totalMin * i) / 4;
    return { pct: (min / totalMin) * 100, label: i === 0 && baseMs === null ? t('course.ganttNow') : hhmm(min, baseMs) };
  });
  const anyEstimate = segments.some(({ stop }) => stop.predictedCongestion == null && stopEstimate(stop));

  return (
    <View
      className="gap-[12px] rounded-2xl border border-line bg-white p-[16px]"
      style={{ boxShadow: shadows.card }}
    >
      <Text className="text-[11px] leading-[16.5px] text-muk-soft" weight="medium">
        {t('course.ganttHint')}
      </Text>
      <View className="h-[16px]" onLayout={(e) => setTrackW(Math.round(e.nativeEvent.layout.width))}>
        {ticks.map((tk, i) => {
          const last = i === ticks.length - 1;
          const align = i === 0 ? 'left' : last ? 'right' : 'center';
          const left = trackW > 0 ? (i === 0 ? 0 : last ? trackW - TICK_BOX : (trackW * tk.pct) / 100 - TICK_BOX / 2) : undefined;
          return (
            <Text
              key={i}
              className="absolute top-0 text-[10px] leading-[15px] text-muk-soft/80"
              weight="medium"
              maxFontSizeMultiplier={1.2}
              style={
                left !== undefined
                  ? { left, width: TICK_BOX, textAlign: align }
                  : last
                    ? { right: 0 }
                    : { left: `${tk.pct}%` }
              }
              numberOfLines={1}
            >
              {tk.label}
            </Text>
          );
        })}
      </View>
      <View className="gap-[12px]">
        {segments.map(({ stop, startPct, widthPct }) => {
          const est = stopEstimate(stop);
          const key = stop.predictedCongestion != null ? congestionOf(stop.predictedCongestion, busyAt) : est ? congestionOf(est.level, busyAt) : null;
          const label =
            stop.predictedCongestion != null && key
              ? t(`congestion.${key}`)
              : est && key
                ? `${t('course.estimateShort')} ${t(`congestion.${key}`)}`
                : '—';
          const barW = trackW > 0 ? Math.max(TICK_BOX, (trackW * widthPct) / 100 - 2) : undefined;
          return (
            <View
              key={stop.facility.id}
              className="gap-[4px]"
              accessible
              accessibilityLabel={`${stop.order}. ${stop.facility.name}, ${arrivalText(stop.arrivalOffsetMin, t, baseMs)}, ${label}`}
            >
              <View className="flex-row items-baseline justify-between gap-[8px]">
                <Text className="min-w-0 flex-1 text-[11px]" weight="bold" numberOfLines={1}>
                  {stop.order}. {typeEmoji(stop.facility.type)} {stop.facility.name}
                </Text>
                <Text className="text-[10px] text-muk-soft" maxFontSizeMultiplier={1.2}>{`🕒 ${arrivalText(stop.arrivalOffsetMin, t, baseMs)}`}</Text>
              </View>
              <View className="h-[28px] overflow-hidden rounded-lg bg-hanji-deep/50">
                {/* 눈금 세로선(연하게) — 웹 absolute top-0 bottom-0 w-px bg-line/60 */}
                {ticks.map((tk, i) => (
                  <View
                    key={i}
                    pointerEvents="none"
                    style={{
                      position: 'absolute',
                      top: 0,
                      bottom: 0,
                      width: 1,
                      left: `${tk.pct}%`,
                      backgroundColor: 'rgba(230, 220, 198, 0.6)', // colors.line 60%
                    }}
                  />
                ))}
                <View
                  className={`absolute bottom-[4px] top-[4px] justify-center rounded-md border px-[8px] ${key ? CONGESTION_CLASS[key] : 'border-line bg-hanji-deep'} ${est && stop.predictedCongestion == null ? 'border-dashed' : ''}`}
                  style={
                    barW !== undefined
                      ? { left: `${startPct}%`, width: barW }
                      : { left: `${startPct}%`, width: `${widthPct}%`, minWidth: TICK_BOX }
                  }
                >
                  <Text className={`text-[10px] leading-[15px] ${key ? CONGESTION_TEXT_CLASS[key] : 'text-muk-soft'}`} weight="bold" numberOfLines={1}>
                    {label}
                  </Text>
                </View>
              </View>
            </View>
          );
        })}
      </View>
      <View className="flex-row flex-wrap items-center gap-x-[12px] gap-y-[4px] pt-[4px]">
        {(['quiet', 'relaxed', 'moderate', 'busy'] as const).map((k) => (
          <View key={k} className="flex-row items-center gap-[4px]">
            {/* Tailwind v4 rounded-sm = 4px(NativeWind 3 의 rounded-sm 은 2px) — 값으로 옮긴다(G4b-R03). */}
            <View className={`h-[10px] w-[10px] rounded-[4px] border ${CONGESTION_CLASS[k]}`} />
            <Text className="text-[10px] leading-[15px] text-muk-soft">{t(`congestion.${k}`)}</Text>
          </View>
        ))}
        {anyEstimate ? (
          <View className="flex-row items-center gap-[4px]">
            <View className="h-[10px] w-[10px] rounded-[4px] border border-dashed border-muk/40" />
            <Text className="text-[10px] leading-[15px] text-muk-soft">{t('map.estimateLegend')}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

// ── 공유 모드 배너 ───────────────────────────────────────────────────────────

export function SharedBanner({ elapsedMin, onNewCourse }: { elapsedMin: number; onNewCourse: () => void }) {
  const t = useT();
  return (
    <View className="flex-row items-center justify-between gap-[12px] rounded-2xl border border-gold/30 bg-gold/10 px-[14px] py-[12px]">
      <Text className="min-w-0 flex-1 text-[11px] leading-[15px] text-gold-deep" weight="semibold">
        {t('course.sharedBanner')}
        {elapsedMin >= 5 ? ` · ${t('course.sharedAgo', { min: elapsedMin })}` : ''}
      </Text>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={t('course.sharedCta')}
        onPress={onNewCourse}
        className="items-center justify-center rounded-full border border-gold/35 bg-white"
        style={{ minHeight: 44, paddingHorizontal: 14, flexShrink: 0 }}
      >
        <Text className="text-center text-[11px] leading-[16.5px] text-gold-deep" weight="bold">
          {t('course.sharedCta')}
        </Text>
      </Pressable>
    </View>
  );
}

// ── 빈 상태 ──────────────────────────────────────────────────────────────────

/** 코스가 하나도 안 나왔을 때 — 서버가 준 자리별 사유를 한 번씩만 말한다. 사유 문구는 종류 이름을 품으므로 완성된 문장으로 모아 중복을 없앤다. */
export function EmptyCourse({ outcomes = [], onWidenTime }: { outcomes?: SlotOutcome[]; onWidenTime?: () => void }) {
  const t = useT();
  const widened =
    onWidenTime && outcomes.some((o) => o.status === 'over_time_budget') ? widenTimeBudget(loadTravelContext()) : null;
  const reasons = [
    ...new Set(
      outcomes
        .filter((o) => o.status !== 'filled')
        .map((o) => {
          const key = slotReasonKey(o);
          return key ? t(key, { type: o.requestedType ? t(`category.${o.requestedType}`) : '' }) : null;
        })
        .filter((line): line is string => Boolean(line)),
    ),
  ];
  return (
    <View
      className="items-center gap-[8px] rounded-2xl border border-line bg-white"
      style={{ padding: 32, boxShadow: shadows.card }}
    >
      <Text className="text-[30px] leading-[36px]" accessibilityElementsHidden importantForAccessibility="no">
        🗺️
      </Text>
      <Text className="text-center text-[14px] leading-[20px]" weight="semibold">
        {t('course.emptyTitle')}
      </Text>
      {reasons.length > 0 ? (
        <View className="items-center gap-[4px]">
          <Text className="text-[11px] leading-[16.5px] text-muk-soft" weight="semibold">
            {t('course.emptyReasonsTitle')}
          </Text>
          <View className="items-center gap-[2px]">
            {reasons.map((line) => (
              <Text key={line} className="text-center text-[12px] leading-[19.5px]">
                {line}
              </Text>
            ))}
          </View>
          <Text className="pt-[4px] text-center text-[11px] leading-[18px] text-muk-soft">{t('course.slotHint')}</Text>
          {widened ? (
            <Button
              label={widened.availableMinutes ? t('course.widenTime', { n: widened.availableMinutes }) : t('course.widenTimeNoLimit')}
              onPress={onWidenTime}
              shape="full"
              labelSize={13}
              paddingX={20}
              className="mt-[8px]"
            />
          ) : null}
        </View>
      ) : (
        <Text className="text-center text-[12px] leading-[19.5px] text-muk-soft">{t('course.emptyBody')}</Text>
      )}
    </View>
  );
}

// ── 세션 없음(401) ───────────────────────────────────────────────────────────

/** 로그인 벽이 아니라 지도로 가는 안내. 익명 세션이 생기면 코스가 이 카드를 스스로 바꾼다. */
export function AuthState({ onGoMap }: { onGoMap: () => void }) {
  const t = useT();
  return (
    <View
      accessibilityRole="alert"
      className="items-center gap-[12px] rounded-2xl border border-gold/30 bg-white"
      style={{ padding: 32, boxShadow: shadows.card }}
    >
      <Text className="text-[30px] leading-[36px]" accessibilityElementsHidden importantForAccessibility="no">
        🗺️
      </Text>
      <Text className="text-center text-[14px] leading-[20px]" weight="semibold">
        {t('course.authTitle')}
      </Text>
      <Text className="text-center text-[12px] leading-[19.5px] text-muk-soft">{t('course.authBody')}</Text>
      <Button label={t('course.authCta')} onPress={onGoMap} shape="full" labelSize={13} paddingX={20} />
    </View>
  );
}

// ── 재조회 중 흐림 ───────────────────────────────────────────────────────────

/** 재조회 중에는 이전 결과를 유지한 채 0.5 로 흐리게(웹 `transition-opacity duration-200` — G4b-R05). 누르기는 막는다. */
export function DimmedResult({ busy, children }: { busy: boolean; children: ReactNode }) {
  const reduceMotion = useReduceMotion();
  const opacity = useSharedValue(busy ? 0.5 : 1);
  useEffect(() => {
    const target = busy ? 0.5 : 1;
    opacity.value = reduceMotion ? target : withTiming(target, { duration: 200 });
  }, [busy, reduceMotion, opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View style={style} pointerEvents={busy ? 'none' : 'auto'} accessibilityState={{ busy }}>
      {children}
    </Animated.View>
  );
}
