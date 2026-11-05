// 코스 화면의 덩어리들 — 웹 course/page.tsx 의 CourseStepper·ViewToggle·CourseGantt·SharedBanner·EmptyState·AuthState·CourseSkeleton.
import { View } from 'react-native';

import { Button, Pressable, Skeleton, Text } from '~/components/ui';
import { useBusyThreshold } from '~/lib/core/publicSettings';
import { useT } from '~/lib/i18n/I18nProvider';
import { widenTimeBudget, loadTravelContext } from '../travelContext';

import { CONGESTION_CLASS, CONGESTION_TEXT_CLASS, congestionOf, stopEstimate } from '../congestionUi';
import { ganttLayout, hhmm, slotReasonKey, typeEmoji } from '../model';
import type { CourseStop, SlotOutcome } from '../types';
import { arrivalText } from './StopRows';

// ── 가로 스텝퍼 ──────────────────────────────────────────────────────────────

/** 정류지 순서 미리보기. 폭이 좁으면(360pt) 칸이 줄어들고 이름은 두 줄까지. 첫 정류지만 강조한다. */
export function CourseStepper({ stops, baseMs }: { stops: CourseStop[]; baseMs: number | null }) {
  const t = useT();
  return (
    <View
      accessibilityLabel={t('course.stepperAria')}
      className="flex-row items-start rounded-2xl border border-line/60 bg-white px-[8px] py-[14px]"
    >
      {stops.map((stop, idx) => {
        const first = idx === 0;
        return (
          <View key={stop.facility.id} className="min-w-0 flex-1 flex-row items-start">
            {idx > 0 ? <View className="mx-[2px] mt-[18px] h-[3px] w-[10px] rounded-full bg-gold/30" /> : null}
            <View className="min-w-0 flex-1 items-center gap-[6px]">
              <View
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                className={`h-[40px] w-[40px] items-center justify-center rounded-full border-2 ${first ? 'border-white bg-gold' : 'border-gold/25 bg-hanji-deep'}`}
              >
                <Text className="text-[16px]">{typeEmoji(stop.facility.type)}</Text>
              </View>
              <Text
                className={`text-center text-[12px] leading-[15px] ${first ? '' : 'text-muk-soft'}`}
                weight={first ? 'extrabold' : 'semibold'}
                numberOfLines={2}
              >
                {stop.facility.name}
              </Text>
              <View className={`rounded-full px-[6px] py-[3px] ${first ? 'bg-gold/15' : 'bg-hanji-deep'}`}>
                <Text className={`text-[10px] ${first ? 'text-gold-deep' : 'text-muk-soft'}`} weight="bold">
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
    <View accessibilityRole="tablist" className="flex-row gap-[4px] self-start rounded-full border border-line bg-white p-[4px]">
      {opts.map((o) => {
        const on = mode === o.id;
        return (
          <Pressable
            key={o.id}
            accessibilityRole="tab"
            accessibilityLabel={o.label}
            accessibilityState={{ selected: on }}
            onPress={() => onChange(o.id)}
            className={`min-h-[44px] items-center justify-center rounded-full px-[18px] ${on ? 'bg-gold-deep' : ''}`}
          >
            <Text className={`text-[12px] ${on ? 'text-white' : 'text-muk-soft'}`} weight="bold">
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ── 간트(시간표) ─────────────────────────────────────────────────────────────

/** 시간축에 정류지를 도착~다음 도착 구간 막대로 놓는다. 막대 색은 도착 시점 예측 혼잡 — 등급 단어만 말한다. 정확한 체류 시각은 서버가 주지 않아 도착 간격으로 근사한다. */
export function CourseGantt({ stops, baseMs }: { stops: CourseStop[]; baseMs: number | null }) {
  const t = useT();
  const busyAt = useBusyThreshold();
  const { segments, totalMin } = ganttLayout(stops);
  const ticks = Array.from({ length: 5 }, (_, i) => {
    const min = (totalMin * i) / 4;
    return { pct: (min / totalMin) * 100, label: i === 0 && baseMs === null ? t('course.ganttNow') : hhmm(min, baseMs) };
  });
  const anyEstimate = segments.some(({ stop }) => stop.predictedCongestion == null && stopEstimate(stop));

  return (
    <View className="gap-[12px] rounded-2xl border border-line bg-white p-[16px]">
      <Text className="text-[12px] text-muk-soft" weight="medium">
        {t('course.ganttHint')}
      </Text>
      <View className="h-[16px]">
        {ticks.map((tk, i) => (
          <Text
            key={i}
            className="absolute top-0 text-[10px] text-muk-soft"
            style={i === ticks.length - 1 ? { right: 0 } : { left: `${tk.pct}%` }}
          >
            {tk.label}
          </Text>
        ))}
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
          return (
            <View
              key={stop.facility.id}
              className="gap-[4px]"
              accessible
              accessibilityLabel={`${stop.order}. ${stop.facility.name}, ${arrivalText(stop.arrivalOffsetMin, t, baseMs)}, ${label}`}
            >
              <View className="flex-row items-baseline justify-between gap-[8px]">
                <Text className="min-w-0 flex-1 text-[12px]" weight="bold" numberOfLines={1}>
                  {stop.order}. {typeEmoji(stop.facility.type)} {stop.facility.name}
                </Text>
                <Text className="text-[10px] text-muk-soft">{`🕒 ${arrivalText(stop.arrivalOffsetMin, t, baseMs)}`}</Text>
              </View>
              <View className="h-[28px] overflow-hidden rounded-lg bg-hanji-deep/50">
                <View
                  className={`absolute bottom-[4px] top-[4px] justify-center rounded-md border px-[8px] ${key ? CONGESTION_CLASS[key] : 'border-line bg-hanji-deep'} ${est && stop.predictedCongestion == null ? 'border-dashed' : ''}`}
                  style={{ left: `${startPct}%`, width: `${Math.max(widthPct, 8)}%`, minWidth: 40 }}
                >
                  <Text className={`text-[10px] ${key ? CONGESTION_TEXT_CLASS[key] : 'text-muk-soft'}`} weight="bold" numberOfLines={1}>
                    {label}
                  </Text>
                </View>
              </View>
            </View>
          );
        })}
      </View>
      <View className="flex-row flex-wrap items-center gap-x-[12px] gap-y-[4px]">
        {(['quiet', 'relaxed', 'moderate', 'busy'] as const).map((k) => (
          <View key={k} className="flex-row items-center gap-[4px]">
            <View className={`h-[10px] w-[10px] rounded-sm border ${CONGESTION_CLASS[k]}`} />
            <Text className="text-[10px] text-muk-soft">{t(`congestion.${k}`)}</Text>
          </View>
        ))}
        {anyEstimate ? (
          <View className="flex-row items-center gap-[4px]">
            <View className="h-[10px] w-[10px] rounded-sm border border-dashed border-muk/40" />
            <Text className="text-[10px] text-muk-soft">{t('map.estimateLegend')}</Text>
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
      <Text className="min-w-0 flex-1 text-[12px] leading-[17px] text-gold-deep" weight="semibold">
        {t('course.sharedBanner')}
        {elapsedMin >= 5 ? ` · ${t('course.sharedAgo', { min: elapsedMin })}` : ''}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('course.sharedCta')}
        onPress={onNewCourse}
        className="min-h-[44px] max-w-[48%] items-center justify-center rounded-full border border-gold/35 bg-white px-[14px]"
      >
        <Text className="text-center text-[12px] text-gold-deep" weight="bold">
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
    <View className="items-center gap-[8px] rounded-2xl border border-line bg-white p-[28px]">
      <Text className="text-[30px] leading-[36px]" accessibilityElementsHidden importantForAccessibility="no">
        🗺️
      </Text>
      <Text className="text-center text-[14px]" weight="semibold">
        {t('course.emptyTitle')}
      </Text>
      {reasons.length > 0 ? (
        <View className="items-center gap-[4px]">
          <Text className="text-[12px] text-muk-soft" weight="semibold">
            {t('course.emptyReasonsTitle')}
          </Text>
          {reasons.map((line) => (
            <Text key={line} className="text-center text-[13px] leading-[19px]">
              {line}
            </Text>
          ))}
          <Text className="pt-[4px] text-center text-[12px] leading-[17px] text-muk-soft">{t('course.slotHint')}</Text>
          {widened ? (
            <Button
              label={widened.availableMinutes ? t('course.widenTime', { n: widened.availableMinutes }) : t('course.widenTimeNoLimit')}
              onPress={onWidenTime}
              className="mt-[8px]"
            />
          ) : null}
        </View>
      ) : (
        <Text className="text-center text-[13px] leading-[19px] text-muk-soft">{t('app.course.emptyBody')}</Text>
      )}
    </View>
  );
}

// ── 세션 없음(401) ───────────────────────────────────────────────────────────

/** 로그인 벽이 아니라 지도로 가는 안내. 익명 세션이 생기면 코스가 이 카드를 스스로 바꾼다. */
export function AuthState({ onGoMap }: { onGoMap: () => void }) {
  const t = useT();
  return (
    <View accessibilityRole="alert" className="items-center gap-[10px] rounded-2xl border border-gold/30 bg-white p-[28px]">
      <Text className="text-[30px] leading-[36px]" accessibilityElementsHidden importantForAccessibility="no">
        🗺️
      </Text>
      <Text className="text-center text-[14px]" weight="semibold">
        {t('course.authTitle')}
      </Text>
      <Text className="text-center text-[13px] leading-[19px] text-muk-soft">{t('course.authBody')}</Text>
      <Button label={t('course.authCta')} onPress={onGoMap} />
    </View>
  );
}

// ── 로딩 스켈레톤 ────────────────────────────────────────────────────────────

/** 첫 로드 스켈레톤 — 실제 레이아웃(요약 · 스텝퍼 · 행)을 흉내 내고 진행 내레이션 제목만 둔다(가짜 결과·수치 없음). */
export function CourseSkeleton({ mode, title }: { mode: 'course' | 'shared'; title: string }) {
  return (
    <View accessibilityLabel={title} accessibilityState={{ busy: true }} accessible className="gap-[20px]">
      <View className="gap-[10px] rounded-2xl border border-line/70 bg-hanji-deep/45 p-[16px]">
        <Text className="text-[16px]" weight="bold">
          {title}
        </Text>
        <Skeleton height={14} width="70%" />
        <Skeleton height={14} width="45%" />
      </View>
      <Skeleton height={104} radius={16} />
      {[0, 1, mode === 'course' ? 2 : 1].map((i) => (
        <View key={i} className="flex-row gap-[12px]">
          <Skeleton height={36} width={36} radius={9999} />
          <View className="flex-1 gap-[8px]">
            <Skeleton height={16} width="60%" />
            <Skeleton height={12} width="85%" />
          </View>
          <Skeleton height={56} width={56} radius={12} />
        </View>
      ))}
    </View>
  );
}
