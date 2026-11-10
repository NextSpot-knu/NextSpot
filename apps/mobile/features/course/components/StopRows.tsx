// 코스 정류지 목록 — 웹 course/page.tsx 의 StopRows·StopRow·DroppedSlotRow (기준 커밋 0d145a1).
// 타임라인 조판(번호 원 + 금빛 세로 연결선), 못 채운 자리는 사유를 달아 자리를 지킨다. 길안내는 카카오 도보 핸드오프(앱 → 웹 폴백).
import { ChevronDown, Navigation } from 'lucide-react-native';
import { Image } from 'expo-image';
import { useState } from 'react';
import { View } from 'react-native';

import { Gradient, Icon, Pressable, Text, toast } from '~/components/ui';
import { useBusyThreshold } from '~/lib/core/publicSettings';
import { spotPoints } from '~/lib/core/spotPoints';
import { useT, type TFunc } from '~/lib/i18n/I18nProvider';
import { haptic } from '~/lib/platform/haptics';
import { openDrivingDirections, openWalkingDirections } from '~/lib/platform/links';
import { track } from '~/lib/platform/analytics';
import { toHttpsImageUrls } from '~/lib/platform/images';
import { stopCalmerOnArrival } from '@/lib/courseStopReason';

import { CONGESTION_CLASS, CONGESTION_TEXT_CLASS, congestionOf, stopEstimate } from '../congestionUi';
import { formatEstimateTime, uncreditedPhotoCandidates } from '../evidence';
import { arrivalParts, buildRows, hhmm, slotReasonKey, typeEmoji, walkMinutesOf } from '../model';
import { loadTravelContext } from '../travelContext';
import { recordActiveTrip } from '../tripAdapter';
import type { CourseStop, SlotOutcome } from '../types';

export function arrivalText(offsetMin: number, t: TFunc, baseMs: number | null): string {
  const { key, vars } = arrivalParts(offsetMin);
  return `${t(key, vars)} · ${hhmm(offsetMin, baseMs)}`;
}

function Timeline({ dashed }: { dashed?: boolean }) {
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        position: 'absolute',
        left: 17,
        top: 54,
        bottom: -12,
        width: 2,
        borderRadius: 1,
        backgroundColor: 'rgba(193, 154, 62, 0.3)', // colors.gold 30%
        opacity: dashed ? 0.5 : 1,
      }}
    />
  );
}

export function StopRows({
  stops,
  readOnly = false,
  outcomes = [],
  pins = {},
  slotKeys = [],
  slotsStale = false,
  baseMs = null,
  onTogglePin,
  onSwap,
  onUnpin,
}: {
  stops: CourseStop[];
  readOnly?: boolean;
  outcomes?: SlotOutcome[];
  pins?: Record<string, string>;
  slotKeys?: string[];
  /** 보이는 행이 이미 지나간 계획의 것인가(순서를 바꿨는데 새 계획이 아직 안 온 창). */
  slotsStale?: boolean;
  baseMs?: number | null;
  onTogglePin?: (slotIdx: number, facilityId: string) => void;
  onSwap?: (slotIdx: number, facilityId: string) => void;
  onUnpin?: (slotIdx: number) => void;
}) {
  // 자리 결과가 없으면 구 API 응답이다 — 서버가 pins 를 모르므로 고정·갈아끼우기는 그리지 않는다(눌러도 아무 일도 없는 조작을 주지 않는다).
  const replanSupported = outcomes.length > 0 && !slotsStale;
  const rows = buildRows(stops, outcomes);
  return (
    <View>
      {rows.map((row, i) => {
        const last = i === rows.length - 1;
        if (row.stop) {
          const slotIdx = replanSupported && row.slotOrder - 1 < slotKeys.length ? row.slotOrder - 1 : undefined;
          return (
            <StopRow
              key={row.stop.facility.id}
              stop={row.stop}
              last={last}
              readOnly={readOnly}
              baseMs={baseMs}
              slotIdx={slotIdx}
              pinned={pins[slotKeys[row.slotOrder - 1]] === row.stop.facility.id}
              onTogglePin={onTogglePin}
              onSwap={onSwap}
            />
          );
        }
        return (
          <DroppedSlotRow
            key={`slot-${row.slotOrder}`}
            outcome={row.outcome}
            last={last}
            // 고정한 가게가 자격에 걸려 자리가 비면 해제 수단이 사라지지 않게 여기에 둔다.
            onUnpin={
              replanSupported && row.outcome.pinned && row.slotOrder - 1 < slotKeys.length && !readOnly
                ? () => onUnpin?.(row.slotOrder - 1)
                : undefined
            }
          />
        );
      })}
    </View>
  );
}

export function DroppedSlotRow({ outcome, last, onUnpin }: { outcome: SlotOutcome; last: boolean; onUnpin?: () => void }) {
  const t = useT();
  const reasonKey = slotReasonKey(outcome);
  return (
    <View className="py-[10px]">
      {!last && <Timeline dashed />}
      <View className="flex-row items-start gap-[12px]">
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          className="h-[36px] w-[36px] items-center justify-center rounded-full border-2 border-dashed border-line bg-hanji"
        >
          <Text className="text-[16px] text-muk-soft">{outcome.requestedType ? typeEmoji(outcome.requestedType) : '·'}</Text>
        </View>
        <View className="min-w-0 flex-1 gap-[4px] rounded-2xl border border-dashed border-line bg-hanji-deep/40 px-[14px] py-[12px]">
          <Text className="text-[13px] text-muk-soft" weight="bold">
            {t('course.slotDroppedHere')}
          </Text>
          {reasonKey ? (
            <Text className="text-[12px] leading-[18px] text-muk-soft">
              {t(reasonKey, { type: outcome.requestedType ? t(`category.${outcome.requestedType}`) : '' })}
            </Text>
          ) : null}
          <Text className="text-[11px] leading-[16px] text-muk-soft">{t('course.slotHint')}</Text>
          {onUnpin ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('course.unpin')}
              onPress={onUnpin}
              className="mt-[6px] min-h-[44px] self-start flex-row items-center justify-center rounded-full border border-line bg-white px-[14px]"
            >
              <Text className="text-[12px] text-muk-soft" weight="bold">
                📌 {t('course.unpin')}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function Pill({ children, className, textClass }: { children: string; className: string; textClass: string }) {
  return (
    <View className={`flex-row items-center rounded-full border px-[8px] py-[4px] ${className}`}>
      <Text className={`text-[12px] ${textClass}`} weight="bold">
        {children}
      </Text>
    </View>
  );
}

export function StopRow({
  stop,
  last,
  readOnly = false,
  baseMs,
  slotIdx,
  pinned = false,
  onTogglePin,
  onSwap,
}: {
  stop: CourseStop;
  last: boolean;
  readOnly?: boolean;
  baseMs: number | null;
  slotIdx?: number;
  pinned?: boolean;
  onTogglePin?: (slotIdx: number, facilityId: string) => void;
  onSwap?: (slotIdx: number, facilityId: string) => void;
}) {
  const t = useT();
  const busyAt = useBusyThreshold();
  const [open, setOpen] = useState(false);
  const [altsOpen, setAltsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [photoIdx, setPhotoIdx] = useState(0);
  const alternatives = stop.alternatives ?? [];
  const canReplan = !readOnly && slotIdx !== undefined && slotIdx >= 0;
  const cong = stop.predictedCongestion == null ? null : congestionOf(stop.predictedCongestion, busyAt);
  const est = cong ? null : stopEstimate(stop);
  const estKey = est ? congestionOf(est.level, busyAt) : null;
  const photoUrls = toHttpsImageUrls(uncreditedPhotoCandidates(stop.facility.imageUrl, stop.facility.galleryImages));
  const photoUrl = photoUrls[photoIdx] ?? null;
  const walk = walkMinutesOf(stop.travelMinutes);
  const crowdLabel = cong ? t(`congestion.${cong}`) : null;
  // 추천 이유는 이 화면의 언어로 만든다 — 서버 문장은 한국어 한 벌이다.
  const reasonText = [
    t('course.stopWhy'),
    crowdLabel ? t('course.stopReasonCrowd', { label: crowdLabel }) : null,
    stopCalmerOnArrival(stop.reason) ? t('course.stopCalmer') : null,
  ]
    .filter(Boolean)
    .join(' ');

  const startNavigation = (mode: 'walk' | 'car') => {
    const walkMinutes = stop.travelMinutes ?? stop.arrivalOffsetMin;
    recordActiveTrip(stop.facility, {
      walkMinutes,
      context: loadTravelContext() as unknown as Record<string, unknown>,
      navigationMode: mode,
    });
    track('navigation_started', {
      facility_type: stop.facility.type,
      navigation_mode: mode,
      walk_minutes: Math.round(walkMinutes),
    });
    haptic('confirm');
    const dest = { name: stop.facility.name, latitude: stop.facility.latitude, longitude: stop.facility.longitude };
    if (mode === 'car') {
      toast.info(t('trip.driveBasisHint'));
      void openDrivingDirections(dest);
    } else {
      toast.info(t('trip.selectWalking'));
      void openWalkingDirections(dest);
    }
  };

  const linkBtn = 'min-h-[44px] flex-row items-center gap-[4px] rounded-full px-[10px]';
  const outlineBtn = 'min-h-[44px] flex-row items-center justify-center rounded-full border border-line bg-white px-[14px]';

  return (
    <View className="py-[12px]">
      {!last && <Timeline />}
      <View className="flex-row items-start gap-[12px]">
        <View
          className="h-[36px] w-[36px] items-center justify-center rounded-full border-2 border-white bg-gold"
          accessibilityLabel={String(stop.order)}
        >
          <Text className="text-[14px] text-white" weight="extrabold">
            {stop.order}
          </Text>
        </View>
        <View className="min-w-0 flex-1">
          <View className="flex-row items-start justify-between gap-[12px]">
            <View className="min-w-0 flex-1 gap-[6px]">
              <Text className="text-[15px] leading-[21px]" weight="bold" numberOfLines={2}>
                {typeEmoji(stop.facility.type)} {stop.facility.name}
              </Text>
              {pinned ? (
                <View className="self-start rounded-full border border-gold/30 bg-gold/15 px-[6px] py-[2px]">
                  <Text className="text-[10px] text-gold-deep" weight="bold">
                    📌 {t('course.pinnedBadge')}
                  </Text>
                </View>
              ) : null}
              <View className="flex-row flex-wrap items-center gap-[6px]">
                <Pill className="border-transparent bg-hanji-deep" textClass="text-muk">
                  {`🕒 ${t('course.stepperOffset', { time: hhmm(stop.arrivalOffsetMin, baseMs) })}`}
                </Pill>
                {walk !== null ? (
                  <Pill className="border-jade/30 bg-jade/10" textClass="text-jade">
                    {`🚶 ${t('compare.benefitWalk', { walk })}`}
                  </Pill>
                ) : null}
                {cong && crowdLabel ? (
                  <Pill className={CONGESTION_CLASS[cong]} textClass={CONGESTION_TEXT_CLASS[cong]}>
                    {crowdLabel}
                  </Pill>
                ) : null}
                {est && estKey ? (
                  // 추정은 도착 시각 예측이 아니라 '관측 시각의 지금' 값이다 — 점선 테두리로 구분한다.
                  <View className={`flex-row items-center rounded-full border border-dashed bg-white/70 px-[8px] py-[4px] ${CONGESTION_CLASS[estKey].split(' ')[0]}`}>
                    <Text className={`text-[12px] ${CONGESTION_TEXT_CLASS[estKey]}`} weight="bold">
                      {t('course.estimateChip', { label: t(`congestion.${estKey}`) })}
                    </Text>
                  </View>
                ) : null}
                {/* '영업시간 미확인' 은 그리지 않는다 — 모른다는 사실은 고르는 데 쓸 정보가 아니다. */}
                {stop.openStatusAtArrival && stop.openStatusAtArrival !== 'needs_confirmation' ? (
                  <Pill
                    className={stop.openStatusAtArrival === 'open_expected' ? 'border-jade/30 bg-jade/10' : 'border-terracotta/30 bg-terracotta/10'}
                    textClass={stop.openStatusAtArrival === 'open_expected' ? 'text-jade' : 'text-terracotta'}
                  >
                    {t(`card.arrivalStatus.${stop.openStatusAtArrival}`)}
                  </Pill>
                ) : null}
              </View>
            </View>
            {/* 56pt 사진 — 없거나 깨지면 장소 표지(유형 이모지). */}
            <View
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              className="h-[56px] w-[56px] items-center justify-center overflow-hidden rounded-xl border border-line bg-tile-slate-bg"
            >
              <Text className="text-[22px]">{typeEmoji(stop.facility.type)}</Text>
              {photoUrl ? (
                <Image
                  key={photoUrl}
                  source={{ uri: photoUrl }}
                  contentFit="cover"
                  onError={() => setPhotoIdx((i) => i + 1)}
                  style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
                />
              ) : null}
            </View>
          </View>

          <View className="mt-[6px] flex-row flex-wrap items-center gap-[6px]">
            {!readOnly ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('course.reasonToggle')}
                accessibilityState={{ expanded: open }}
                onPress={() => setOpen((v) => !v)}
                className={linkBtn}
              >
                <Text className="text-[12px] text-gold-deep" weight="bold">
                  {t('course.reasonToggle')}
                </Text>
                <Icon icon={ChevronDown} size="xs" color="gold-deep" />
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('course.moreActions')}
              accessibilityState={{ expanded: moreOpen }}
              onPress={() => setMoreOpen((v) => !v)}
              className={linkBtn}
            >
              <Text className="text-[12px] text-muk-soft" weight="bold">
                {t('course.moreActions')}
              </Text>
              <Icon icon={ChevronDown} size="xs" color="muk-soft" />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('course.directionsAria', { name: stop.facility.name })}
              onPress={() => startNavigation('walk')}
              className="ml-auto min-h-[44px] overflow-hidden rounded-full"
            >
              <Gradient name="cta" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
              <View className="min-h-[44px] flex-row items-center gap-[6px] px-[16px]">
                <Icon icon={Navigation} size="sm" color="white" />
                <Text className="text-[12px] text-white" weight="bold">
                  {t('course.directions')}
                </Text>
              </View>
            </Pressable>
          </View>

          {!readOnly && open ? (
            <View className="mt-[8px] gap-[6px] rounded-r-xl border-l-2 border-gold/45 bg-hanji-deep/60 px-[12px] py-[10px]">
              <Text className="text-[13px] leading-[19px]">{reasonText}</Text>
              {est ? (
                <Text className="text-[11px] leading-[16px] text-muk-soft">
                  {t('card.evidenceEstimated', { time: formatEstimateTime(est.observedAt) ?? '—' })}
                </Text>
              ) : null}
              <View className="self-start rounded-full border border-line bg-white px-[8px] py-[2px]">
                <Text className="text-[11px] text-muk-soft" weight="semibold">
                  {t('course.spotScore', { score: spotPoints(stop.spotScore) })}
                </Text>
              </View>
            </View>
          ) : null}

          {moreOpen ? (
            <View className="mt-[8px] flex-row flex-wrap items-center gap-[8px]">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('course.drivingAria', { name: stop.facility.name })}
                onPress={() => startNavigation('car')}
                className={outlineBtn}
              >
                <Text className="text-[12px] text-muk-soft" weight="bold">
                  {t('course.driving')}
                </Text>
              </Pressable>
              {canReplan && alternatives.length > 0 ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: altsOpen }}
                  accessibilityLabel={altsOpen ? t('course.altsHide') : t('course.altsToggle', { n: alternatives.length })}
                  onPress={() => setAltsOpen((v) => !v)}
                  className={`${outlineBtn} flex-row gap-[4px]`}
                >
                  <Text className="text-[12px] text-muk-soft" weight="bold">
                    {altsOpen ? t('course.altsHide') : t('course.altsToggle', { n: alternatives.length })}
                  </Text>
                  <Icon icon={ChevronDown} size="xs" color="muk-soft" />
                </Pressable>
              ) : null}
              {canReplan ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: pinned }}
                  accessibilityLabel={pinned ? t('course.pinOff') : t('course.pinOn')}
                  onPress={() => onTogglePin?.(slotIdx as number, stop.facility.id)}
                  className={`min-h-[44px] flex-row items-center justify-center rounded-full border px-[14px] ${pinned ? 'border-gold bg-gold/15' : 'border-line bg-white'}`}
                >
                  <Text className={`text-[12px] ${pinned ? 'text-gold-deep' : 'text-muk-soft'}`} weight="bold">
                    📌 {pinned ? t('course.pinOff') : t('course.pinOn')}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}

          {canReplan && moreOpen && altsOpen && alternatives.length > 0 ? (
            <View className="mt-[10px] overflow-hidden rounded-2xl border border-line bg-hanji-deep/40">
              {alternatives.map((alt, i) => {
                const altCong = alt.predictedCongestion == null ? null : congestionOf(alt.predictedCongestion, busyAt);
                const altEst = altCong ? null : stopEstimate(alt);
                return (
                  <View key={alt.facility.id} className={`flex-row items-center gap-[8px] px-[12px] py-[8px] ${i > 0 ? 'border-t border-line/70' : ''}`}>
                    <View className="min-w-0 flex-1">
                      <Text className="text-[13px]" weight="bold" numberOfLines={1}>
                        {typeEmoji(alt.facility.type)} {alt.facility.name}
                      </Text>
                      <Text className="text-[11px] text-muk-soft">
                        {`🕒 ${arrivalText(alt.arrivalOffsetMin, t, baseMs)}`}
                        {altCong ? ` · ${t(`congestion.${altCong}`)}` : ''}
                        {altEst ? ` · ${t('course.estimateChip', { label: t(`congestion.${congestionOf(altEst.level, busyAt)}`) })}` : ''}
                      </Text>
                    </View>
                    {/* 보이는 글자는 '여기로 바꾸기' 하나라 이름을 aria 에 넣어야 어느 가게인지 구분된다. */}
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('course.altsPickAria', { name: alt.facility.name })}
                      onPress={() => onSwap?.(slotIdx as number, alt.facility.id)}
                      className="min-h-[44px] items-center justify-center rounded-full border border-gold/35 bg-gold/10 px-[12px]"
                    >
                      <Text className="text-[11px] text-gold-deep" weight="bold">
                        {t('course.altsPick')}
                      </Text>
                    </Pressable>
                  </View>
                );
              })}
              <View className="bg-white/50 px-[12px] py-[10px]">
                <Text className="text-[11px] leading-[16px] text-muk-soft">{t('course.altsNote')}</Text>
              </View>
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}
