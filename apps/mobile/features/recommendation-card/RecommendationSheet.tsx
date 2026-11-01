import {
  Bookmark,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  Coffee,
  Globe,
  MapPin,
  Phone,
  RefreshCw,
  Sparkles,
  Utensils,
} from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';

import {
  Button,
  Card,
  ErrorState,
  EmptyState,
  Icon,
  Pressable,
  Sheet,
  SheetScrollView,
  SheetView,
  Skeleton,
  Text,
  cn,
  toast,
  type SheetState,
} from '~/components/ui';
import {
  apiClient,
  reportFacilityAvailability,
  type TravelContext,
} from '~/lib/core/apiClient';
import { useBusyThreshold } from '~/lib/core/publicSettings';
import { haptic } from '~/lib/platform/haptics';
import { openExternalUrl, openPhone } from '~/lib/platform/links';
import { trackEvent, usageCardProps } from '~/lib/platform/analytics';
import { LIVE_FLASH_MS, LIVE_REFRESH_COOLDOWN_MS, refreshedFields, type LiveField } from '@/lib/liveDetailDiff';

import { acceptCandidate, keepCandidate, rejectCandidate, type NavigationMode } from './actions';
import { nextCandidateAfter } from './actionsCore';
import { BenefitChip, DetailRow, ToggleButton } from './CardParts';
import { CardPhoto } from './CardPhoto';
import { buildCardModel, formatClock, type AvailabilityLocal, type CardModel, type LiveDetail } from './cardModel';
import { CongestionReportButton } from './CongestionReportButton';
import { DayForecast, GoldenHourLine } from './Extras';
import { hoursAnswerNotRecorded, type ReportLevel } from './reportCore';
import { loadHiddenPhotos } from './photoSafety';
import { useCardT } from './useCardT';
import { localReportLevel } from './tripLoop';
import type { CompareAnchor, SheetCandidate } from './types';

export interface RecommendationSheetProps {
  /** 지금 보이는 장소. 없으면 status 에 따라 빈·로딩·오류 판을 그린다(ready 이면 아무것도 그리지 않는다). */
  selected: SheetCandidate | null;
  /** 보이는 추천 목록(순위 순). 순위 배지 · 취향 비교 · '다음 후보' 를 여기서 계산한다. */
  candidates: readonly SheetCandidate[];
  /** 이미 킵·거절해 다시 보이면 안 되는 장소 id(홈이 세션 동안 들고 있는 것). 이 시트가 처리한 것은 자동으로 더해진다. */
  excludedIds?: ReadonlySet<string>;
  status?: 'ready' | 'loading' | 'error' | 'empty';
  onRetry?: () => void;
  /** 비교 헤더의 기준 명소('A 대신 B'). */
  compareAnchor?: CompareAnchor | null;
  /** 2·3번째 추천의 '추천 이유'(1위 대비 차이) — 문장의 순위가 카드 순위와 같을 때만 홈이 넘긴다. */
  comparisonReason?: string;
  travelContext?: TravelContext;
  /** 첫 높이. 새 장소가 뜰 때마다 이 높이로 연다 — 웹 휴대폰 배치는 미리보기(minimized)로 연다. */
  openAs?: SheetState;
  /** 아래 탭 막대 높이(pt). */
  bottomInset?: number;
  /** '바로 갈래요'·'자동차 길안내' 뒤(서버 수락·여정 기록·길안내는 시트가 이미 했다). */
  onAccept?: (c: SheetCandidate, mode: NavigationMode) => void;
  /** 킵 뒤 — next 가 다음에 보일 후보(없으면 null → 빈 상태). */
  onKeep?: (c: SheetCandidate, next: SheetCandidate | null) => void;
  /** 다시 안볼래요 뒤. */
  onReject?: (c: SheetCandidate, next: SheetCandidate | null) => void;
  /** 직접 고른 장소의 '대신 갈 곳 보기'. 주면 userPicked 장소에서만 버튼이 열린다. */
  onShowAlternatives?: (c: SheetCandidate) => void;
  onClose?: () => void;
  /** '취향 프로필에 반영했어요 · 보기' / 실험실 안내의 '보기' 이동. 없으면 버튼 없이 알린다. */
  onViewProfile?: () => void;
  onViewLab?: () => void;
  /**
   * '다시 안볼래요' 를 서버 거절·취향 학습 없이 알리기만 한다 — 저장 목록처럼 '목록에서 뺀다' 는 정리 동작일 때(웹 저장 화면의 onReject 는 unsaved).
   * 뒤처리(삭제·알림)는 onReject 가 맡는다.
   */
  rejectIsRemoval?: boolean;
  /** 시트 높이(미리보기·기본·펼침)가 바뀔 때 — 홈이 지도 가려진 띠를 다시 계산한다. */
  onStateChange?: (state: SheetState) => void;
}

const SNAPS = ['27%', '52%', '90%'] as const;

export function RecommendationSheet(props: RecommendationSheetProps) {
  const { selected, status = 'ready', openAs = 'minimized', bottomInset = 0 } = props;
  const { t } = useCardT();
  const [sheetState, setSheetState] = useState<SheetState>(openAs);
  const stateLabels = useMemo(
    () => ({
      minimized: t('cardSheet.state.minimized'),
      normal: t('cardSheet.state.normal'),
      expanded: t('cardSheet.state.expanded'),
    }),
    [t],
  );
  const id = selected?.facility.id ?? null;
  useEffect(() => {
    setSheetState(openAs);
  }, [id, openAs]);
  const onStateChangeRef = useRef(props.onStateChange);
  onStateChangeRef.current = props.onStateChange;
  useEffect(() => {
    onStateChangeRef.current?.(sheetState);
  }, [sheetState]);

  if (!selected && status === 'ready') return null;
  return (
    <Sheet
      snapPoints={SNAPS}
      state={sheetState}
      onStateChange={setSheetState}
      handleLabel={t('cardSheet.handle')}
      stateLabels={stateLabels}
      bottomInset={bottomInset}
    >
      {selected && status === 'ready' ? (
        <CardBody {...props} selected={selected} sheetState={sheetState} setSheetState={setSheetState} />
      ) : (
        <SheetView style={{ paddingHorizontal: 16, paddingBottom: 16 }}>
          {status === 'loading' ? (
            <View accessibilityRole="progressbar" accessibilityLabel={t('common.loading')} className="gap-[10px] pt-[4px]">
              <Skeleton height={20} width="70%" />
              <Skeleton height={14} width="90%" />
              <Skeleton height={44} radius={16} />
            </View>
          ) : status === 'error' ? (
            <ErrorState message={t('recommend.loadFailed')} onRetry={props.onRetry ?? (() => undefined)} retryLabel={t('common.retry')} />
          ) : (
            <EmptyState emoji="🧭" title={t('cardSheet.emptyTitle')} description={t('map.noRecBody')} />
          )}
        </SheetView>
      )}
    </Sheet>
  );
}

function CardBody(
  props: RecommendationSheetProps & {
    selected: SheetCandidate;
    sheetState: SheetState;
    setSheetState: (s: SheetState) => void;
  },
) {
  const { selected: c, candidates, sheetState, setSheetState } = props;
  const { t, locale } = useCardT();
  const busyAt = useBusyThreshold();
  const f = c.facility;
  const [now, setNow] = useState<Date | null>(null);
  const [confirmed, setConfirmed] = useState<'saved' | 'accepted' | null>(null);
  const [spotOpen, setSpotOpen] = useState(false);
  const [whyOpen, setWhyOpen] = useState(false);
  const [localReport, setLocalReport] = useState<{ level: number; timestamp: string } | null>(null);
  const [hoursPrompt, setHoursPrompt] = useState(false);
  const [hoursBusy, setHoursBusy] = useState(false);
  const [hoursError, setHoursError] = useState(false);
  const [localAvailability, setLocalAvailability] = useState<AvailabilityLocal | null>(null);
  const [localHours, setLocalHours] = useState<'open' | 'closed' | null>(null);
  const [liveDetail, setLiveDetail] = useState<LiveDetail | null>(null);
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveAt, setLiveAt] = useState<Date | null>(null);
  const [flash, setFlash] = useState<LiveField[]>([]);
  const [cooldown, setCooldown] = useState(false);
  const [hidden, setHidden] = useState<string[]>(() => loadHiddenPhotos());
  const handled = useRef<Set<string>>(new Set());
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  // 익명 이용 기록 — 새 장소가 뜰 때 한 건(같은 장소가 다시 그려질 때는 세지 않는다).
  const rank = useMemo(() => {
    if (c.userPicked) return null;
    const i = candidates.findIndex((x) => String(x.facility.id) === String(f.id));
    return i < 0 ? null : i + 1;
  }, [c.userPicked, candidates, f.id]);
  useEffect(() => {
    trackEvent('rec_shown', usageCardProps(f, rank));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.id]);

  // 다른 장소로 바뀌면 이전 장소의 로컬 상태를 비운다.
  useEffect(() => {
    setConfirmed(null);
    setSpotOpen(false);
    setWhyOpen(false);
    setLocalReport(null);
    setHoursPrompt(false);
    setHoursError(false);
    setLocalAvailability(null);
    setLocalHours(null);
    setLiveDetail(null);
    setLiveAt(null);
    setFlash([]);
    setCooldown(false);
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }, [f.id]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const tastePeers = useMemo(() => candidates.map((x) => (typeof x.breakdown?.preference === 'number' ? Math.round(x.breakdown.preference * 100) : null)), [candidates]);
  const model = useMemo(
    () =>
      buildCardModel(c, {
        t,
        now,
        busyAt,
        listRank: rank,
        tastePeers,
        anchor: props.compareAnchor,
        localReport,
        localAvailability,
        localHoursAnswer: localHours,
        liveDetail,
        hiddenPhotos: hidden,
        locale,
      }),
    [c, t, now, busyAt, rank, tastePeers, props.compareAnchor, localReport, localAvailability, localHours, liveDetail, hidden, locale],
  );

  const nextAfter = useCallback(() => {
    const excluded = new Set<string>([...(props.excludedIds ?? []), ...handled.current]);
    return nextCandidateAfter(candidates, f.id, excluded);
  }, [candidates, f.id, props.excludedIds]);

  const doAccept = (mode: NavigationMode) => {
    setConfirmed('accepted');
    acceptCandidate(c, { mode, travelContext: props.travelContext, t, onViewProfile: props.onViewProfile });
    props.onAccept?.(c, mode);
  };
  const doReject = () => {
    haptic('selection');
    trackEvent('rec_next', usageCardProps(f, rank));
    handled.current.add(String(f.id));
    const next = nextAfter();
    if (!props.rejectIsRemoval) rejectCandidate(c, { t, hasNext: next !== null, onViewLab: props.onViewLab });
    props.onReject?.(c, next);
  };
  const doKeep = () => {
    haptic('confirm');
    trackEvent('rec_later', usageCardProps(f, rank));
    setConfirmed('saved');
    handled.current.add(String(f.id));
    keepCandidate(c, t, busyAt);
    props.onKeep?.(c, nextAfter());
  };
  const onAcceptPress = () => {
    haptic('success');
    trackEvent('rec_accept', usageCardProps(f, rank));
    if (model.needsHoursConfirmation && model.kakaoPlaceUrl) {
      // 영업시간을 모르는 음식점·카페 — 카카오맵 영업시간을 먼저 열고 '영업 중인지' 묻는다.
      setHoursPrompt(true);
      setHoursError(false);
      if (sheetState === 'minimized') props.setSheetState('normal');
      void openExternalUrl(model.kakaoPlaceUrl);
      return;
    }
    doAccept('walk');
  };
  const onDrivePress = () => {
    trackEvent('rec_drive', usageCardProps(f, rank));
    haptic('success');
    doAccept('car');
  };

  const answerHours = async (status: 'open' | 'closed') => {
    if (hoursBusy) return;
    const finish = () => {
      setHoursPrompt(false);
      haptic('success');
      if (status === 'closed') doReject();
      else doAccept('walk');
    };
    setHoursBusy(true);
    setHoursError(false);
    try {
      setLocalAvailability(await reportFacilityAvailability(f.id, status));
      finish();
    } catch (err) {
      if (hoursAnswerNotRecorded(err)) {
        // 게스트(403)·같은 네트워크의 다른 계정이 이미 알린 곳(429) — 판단은 잇되 '확인' 칩은 만들지 않는다.
        setLocalHours(status);
        finish();
      } else {
        haptic('selection');
        setHoursError(true);
      }
    } finally {
      setHoursBusy(false);
    }
  };

  const refreshLive = async () => {
    if (!model.canLiveRefresh || liveLoading || cooldown) return;
    setLiveLoading(true);
    try {
      const res = (await apiClient.get(
        `/api/v1/infrastructures/live-detail/${encodeURIComponent(model.liveContentId as string)}?contentTypeId=${model.liveContentTypeId}`,
      )) as (LiveDetail & { source?: string }) | null;
      if (res?.source === 'tourapi-live') {
        const next: LiveDetail = {
          operatingHours: res.operatingHours ?? null,
          overview: res.overview ?? null,
          homepage: res.homepage ?? null,
          imageUrl: res.imageUrl ?? null,
          phone: res.phone ?? null,
        };
        setLiveDetail(next);
        setLiveAt(new Date());
        setFlash(refreshedFields(next as never));
        setCooldown(true);
        props.setSheetState('expanded');
        toast.success(t('card.liveRefreshedToast'));
        timers.current.push(setTimeout(() => setFlash([]), LIVE_FLASH_MS), setTimeout(() => setCooldown(false), LIVE_REFRESH_COOLDOWN_MS));
      }
    } catch {
      /* 무해 폴백 — 캐시된 값을 그대로 둔다(에러 알림 없음) */
    } finally {
      setLiveLoading(false);
    }
  };

  const showInstead = !!props.onShowAlternatives && !!c.userPicked;
  const insteadLabel = t('waiting.seeInstead');
  const onInstead = () => {
    haptic('selection');
    props.onShowAlternatives?.(c);
  };
  const expanded = sheetState === 'expanded';

  // ── 미리보기(가장 낮은 높이) ───────────────────────────────────────────────────
  if (sheetState === 'minimized') {
    return (
      <SheetView style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
        <View className="gap-[8px]">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('card.peek.expand')}
            onPress={() => setSheetState('normal')}
            className="gap-[4px]"
          >
            <Text className="text-[14px] leading-[19px]" weight="extrabold" numberOfLines={2}>{model.peekValueText}</Text>
            <View className="flex-row items-center gap-[6px]">
              <Text className="shrink font-serif text-[16px] leading-[21px]" weight="bold" numberOfLines={1}>{model.title}</Text>
              {model.hasSpot && (
                <View className="rounded-md border border-gold/40 bg-gold/10 px-[6px] py-[2px]">
                  <Text className="text-[11px] leading-[15px] text-gold-deep" weight="extrabold">{t('card.peek.spot', { n: model.spotScore })}</Text>
                </View>
              )}
              <Icon icon={ChevronUp} size="sm" color="gold-deep" />
            </View>
            <View className="flex-row flex-wrap items-center gap-[6px]">
              {model.showArrivalLine && model.times.arrival && now && (
                <View className="flex-row items-center gap-[4px] rounded-md border border-jade/30 bg-jade/15 px-[8px] py-[2px]">
                  <Icon icon={Clock} size="xs" color="jade" />
                  <Text className="text-[11px] leading-[15px] text-jade" weight="extrabold">
                    {t('card.arrivalLine', { depart: formatClock(now), arrive: formatClock(model.times.arrival) })}
                  </Text>
                </View>
              )}
              {model.crowdChip && model.crowdChipOnFace && (
                <View className={cn('rounded-md border px-[8px] py-[2px]', model.crowdChip.dashed ? 'border-dashed' : '', 'border-line bg-white/70')}>
                  <Text className="text-[11px] leading-[15px] text-muk" weight="bold">{model.crowdChip.text}</Text>
                </View>
              )}
              {model.closedToday && (
                <View className="rounded-md border border-terracotta/30 bg-terracotta/10 px-[8px] py-[2px]">
                  <Text className="text-[11px] leading-[15px] text-terracotta" weight="bold">{t('card.closedToday')}</Text>
                </View>
              )}
            </View>
          </Pressable>
          <View className="flex-row gap-[8px]">
            <Button
              className="flex-1"
              label={t('card.accept')}
              accessibilityLabel={t('card.acceptAria')}
              icon={confirmed === 'accepted' ? Check : undefined}
              onPress={onAcceptPress}
            />
            {showInstead ? (
              <Button className="flex-1" variant="secondary" label={insteadLabel} accessibilityLabel={t('card.seeInsteadAria', { name: model.title })} onPress={onInstead} />
            ) : (
              <Button className="flex-1" variant="secondary" label={t('card.reject')} accessibilityLabel={t('card.rejectAria')} onPress={doReject} />
            )}
          </View>
        </View>
      </SheetView>
    );
  }

  // ── 전체 카드 · 펼친 카드 ──────────────────────────────────────────────────────
  return (
    <SheetScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32, gap: 10 }} keyboardShouldPersistTaps="handled">
      <ValueBox model={model} now={now} />

      <View className="flex-row items-start justify-between gap-[12px]">
        <View className="min-w-0 flex-1 gap-[6px]">
          <View className="flex-row flex-wrap items-center gap-[6px]">
            <View className={cn('flex-row items-center gap-[4px] rounded-lg px-[10px] py-[4px]', model.rankIsListed ? 'bg-terracotta' : 'bg-gold/15')}>
              <Icon icon={Sparkles} size="xs" color={model.rankIsListed ? 'white' : 'gold-deep'} />
              <Text className={cn('text-[11px] leading-[15px]', model.rankIsListed ? 'text-white' : 'text-gold-deep')} weight="black">
                {t(model.rankText.key, model.rankText.vars)}
              </Text>
            </View>
          </View>
          {model.faceMenu && (
            <View className="flex-row items-start gap-[4px] rounded-lg border border-gold/35 bg-gold/10 px-[8px] py-[4px]">
              <View className="pt-[2px]" accessibilityElementsHidden importantForAccessibility="no">
                <Icon icon={model.type === 'cafe' ? Coffee : Utensils} size="sm" color="gold-deep" />
              </View>
              <Text className="min-w-0 flex-1 text-[13px] leading-[18px]" weight="bold">
                {model.faceMenu.kind === 'menu' ? `${t('card.signatureMenu')} ` : ''}
                {model.faceMenu.items.join(' · ')}
              </Text>
            </View>
          )}
          <Text className="font-serif text-[20px] leading-[26px]" weight="bold" accessibilityRole="header">{model.title}</Text>
        </View>
        {model.hasSpot && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('card.spotTooltipAria')}
            accessibilityState={{ expanded: spotOpen }}
            onPress={() => setSpotOpen((v) => !v)}
            className={cn('min-h-[60px] min-w-[60px] items-center justify-center gap-[4px] rounded-2xl border px-[8px] py-[6px]', spotOpen ? 'border-gold bg-gold/20' : 'border-gold/40 bg-gold/10')}
          >
            <Text className="text-[12px] leading-[14px] text-gold-deep" weight="bold">{`${t('card.spotScoreLabel')} ⓘ`}</Text>
            <Text className="text-[22px] leading-[24px]" weight="black">
              {model.spotScore}
              <Text className="text-[11px] text-muk-soft">{t('card.pointSuffix')}</Text>
            </Text>
          </Pressable>
        )}
      </View>

      {model.hasSpot && spotOpen && <SpotInfo model={model} t={t} />}

      {(model.faceChips.length > 0 || model.likelyClosedUnknown) && (
        <View className="flex-row flex-wrap items-center gap-[8px]">
          {model.faceChips.map((chip) => (
            <BenefitChip key={chip.key} tone={chip.tone} dashed={chip.dashed}>{chip.text}</BenefitChip>
          ))}
        </View>
      )}
      {model.likelyClosedUnknown && model.times.arrival && (
        <Text className="text-[12px] leading-[18px] text-terracotta" weight="medium">
          {t('card.likelyClosedReason', { time: formatClock(model.times.arrival) })}
        </Text>
      )}

      {showInstead && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('card.seeInsteadAria', { name: model.title })}
          onPress={onInstead}
          className="min-h-[44px] flex-row items-center justify-center gap-[4px] rounded-2xl border border-jade/40 bg-jade/10 px-[12px] py-[8px]"
        >
          <Text className="text-[13px] leading-[18px] text-jade" weight="bold">{insteadLabel}</Text>
          <Icon icon={ChevronRight} size="sm" color="jade" />
        </Pressable>
      )}

      {props.comparisonReason && model.rankIsListed && (rank ?? 0) >= 2 && (
        <View className="rounded-xl border border-jade/20 bg-jade/5 px-[12px] py-[8px]">
          <Text className="text-[11px] leading-[15px] text-jade" weight="extrabold">{t('recommend.spotComparison.current')}</Text>
          <Text className="mt-[2px] text-[12px] leading-[17px]" weight="semibold">{props.comparisonReason}</Text>
        </View>
      )}

      {/* 행동 — 짧은 시트에서도 보이도록 사진보다 먼저(웹은 바닥 고정). */}
      <View className="gap-[8px]">
        <Button
          label={t('card.accept')}
          accessibilityLabel={t('card.acceptAria')}
          icon={confirmed === 'accepted' ? Check : undefined}
          onPress={onAcceptPress}
          block
        />
        <View className="flex-row gap-[8px]">
          <Button className="flex-1" variant="secondary" label={t('card.reject')} accessibilityLabel={t('card.rejectAria')} onPress={doReject} />
          <Button
            className="flex-1"
            variant="secondary"
            icon={confirmed === 'saved' ? Check : Bookmark}
            label={t('card.putOff').replace('\n', ' ')}
            accessibilityLabel={t('card.putOffAria')}
            onPress={doKeep}
          />
        </View>
        {hoursPrompt && (
          <HoursPrompt busy={hoursBusy} error={hoursError} onAnswer={answerHours} onUnsure={() => { setHoursPrompt(false); setHoursError(false); }} />
        )}
        <View className="flex-row items-center gap-[8px]">
          {model.needsHoursConfirmation && model.kakaoPlaceUrl ? (
            <Text className={cn('min-w-0 flex-1 text-[11px] leading-[15px]', model.likelyClosedUnknown ? 'text-terracotta' : 'text-muk-soft')} weight="medium">
              {t('card.checkHoursKakaoHint')}
            </Text>
          ) : (
            <View className="flex-1">
              <Button variant="secondary" label={t('card.drive')} onPress={onDrivePress} />
            </View>
          )}
          <CongestionReportButton
            facility={{ id: f.id, name: f.name }}
            isFirst={model.displayCongestionSource === 'none'}
            onReported={(level: ReportLevel) => setLocalReport({ level: localReportLevel(level), timestamp: new Date().toISOString() })}
          />
        </View>
      </View>

      <CardPhoto
          model={model}
          facilityName={model.title}
          onHidden={(url) => setHidden((h) => (h.includes(url) ? h : [...h, url]))}
          height={expanded ? 200 : 150}
        />

      {model.canLiveRefresh && (
        <View className="flex-row flex-wrap items-center gap-x-[8px] gap-y-[4px]">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('card.liveRefresh')}
            accessibilityState={{ disabled: liveLoading || cooldown, busy: liveLoading }}
            disabled={liveLoading || cooldown}
            onPress={() => void refreshLive()}
            className={cn('min-h-[44px] flex-row items-center gap-[6px] rounded-full border border-gold/60 bg-white px-[14px]', liveLoading || cooldown ? 'opacity-60' : '')}
          >
            <Icon icon={RefreshCw} size="sm" color="gold-deep" />
            <Text className="text-[13px] leading-[18px] text-gold-deep" weight="bold">{t('card.liveRefresh')}</Text>
          </Pressable>
          <Text className="text-[12px] leading-[16px] text-muk-soft" weight="semibold">{t('card.liveCredit')}</Text>
          {liveAt && (
            <View className="rounded-full bg-jade/15 px-[10px] py-[2px]" accessibilityLiveRegion="polite">
              <Text className="text-[12px] leading-[16px] text-jade" weight="bold">{`✓ ${t('card.liveRefreshed', { time: formatClock(liveAt) })}`}</Text>
            </View>
          )}
        </View>
      )}

      <ToggleButton
        label={t(expanded ? 'card.detailsCollapse' : 'card.detailsExpand')}
        expanded={expanded}
        onPress={() => setSheetState(expanded ? 'normal' : 'expanded')}
        icon={<Icon icon={expanded ? ChevronUp : ChevronDown} size="sm" color="gold-deep" />}
      />

      {expanded && (
        <Details
          model={model}
          t={t}
          flash={flash}
          whyOpen={whyOpen}
          setWhyOpen={setWhyOpen}
          comparisonReason={rank !== null && rank < 2 ? props.comparisonReason : undefined}
          facilityId={f.id}
        />
      )}
    </SheetScrollView>
  );
}

function ValueBox({ model, now }: { model: CardModel; now: Date | null }) {
  const { t } = useCardT();
  return (
    <View className="rounded-2xl border border-terracotta/25 bg-terracotta/10 px-[12px] py-[8px]">
      <View className="flex-row flex-wrap items-center gap-x-[8px] gap-y-[4px]">
        <Text className="text-[12px] leading-[16px] text-terracotta" weight="bold">{model.compareKicker}</Text>
        {model.showArrivalLine && model.times.arrival && now && (
          <View className="flex-row items-center gap-[6px] rounded-full bg-jade/15 px-[10px] py-[2px]">
            <Icon icon={Clock} size="sm" color="jade" />
            <Text className="text-[13px] leading-[18px] text-jade" weight="extrabold">
              {t('card.arrivalLine', { depart: formatClock(now), arrive: formatClock(model.times.arrival) })}
            </Text>
          </View>
        )}
      </View>
      <Text className="mt-[2px] text-[17px] leading-[23px]" weight="extrabold" accessibilityRole="header">
        {model.valueSentence ?? `${model.title} · ${model.benefitParts.join(' · ')}`}
      </Text>
    </View>
  );
}

function SpotInfo({ model, t }: { model: CardModel; t: (k: string, v?: Record<string, string | number>) => string }) {
  return (
    <View className="rounded-2xl border border-gold/35 bg-gold/10 px-[14px] py-[12px]">
      <Text className="text-[13px] leading-[18px] text-gold-deep" weight="extrabold">{t('card.spotTooltipTitle')}</Text>
      <Text className="mt-[4px] text-[12px] leading-[18px]">{t('card.spotInfoIntro')}</Text>
      <Text className="mt-[8px] text-[11px] leading-[15px] text-muk-soft" weight="bold">{t('card.spotInfoPlace')}</Text>
      {model.preferencePercent !== null && <Text className="mt-[2px] text-[12px] leading-[17px]" weight="semibold">{`· ${t('card.spotInfoTaste', { pct: model.preferencePercent })}`}</Text>}
      <Text className="text-[12px] leading-[17px]" weight="semibold">
        {`· ${model.times.waitMin !== null
          ? t('card.spotInfoTimeWait', { walk: model.times.walkMin, wait: model.times.waitMin })
          : t('card.spotInfoTime', { walk: model.times.walkMin })}`}
      </Text>
      {model.perkText && <Text className="text-[12px] leading-[17px]" weight="semibold">{`· ${t('card.spotInfoPerk', { perk: model.perkText })}`}</Text>}
    </View>
  );
}

function HoursPrompt({
  busy,
  error,
  onAnswer,
  onUnsure,
}: {
  busy: boolean;
  error: boolean;
  onAnswer: (s: 'open' | 'closed') => void;
  onUnsure: () => void;
}) {
  const { t } = useCardT();
  return (
    <View accessibilityRole="none" accessibilityLabel={t('card.hoursCheckQuestion')} className="rounded-2xl border border-gold/30 bg-gold/10 p-[12px]">
      <Text className="text-[13px] leading-[18px]" weight="extrabold">{t('card.hoursCheckQuestion')}</Text>
      <Text className="mt-[4px] text-[11px] leading-[16px] text-muk-soft">{t('card.hoursCheckPrivacy')}</Text>
      <View className="mt-[12px] flex-row gap-[8px]">
        <Pressable accessibilityRole="button" disabled={busy} accessibilityLabel={t('card.hoursOpen')} onPress={() => onAnswer('open')} className={cn('min-h-[44px] flex-1 items-center justify-center rounded-xl bg-jade px-[6px]', busy ? 'opacity-50' : '')}>
          <Text className="text-center text-[12px] leading-[16px] text-white" weight="bold">{t('card.hoursOpen')}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" disabled={busy} accessibilityLabel={t('card.hoursClosed')} onPress={() => onAnswer('closed')} className={cn('min-h-[44px] flex-1 items-center justify-center rounded-xl bg-terracotta px-[6px]', busy ? 'opacity-50' : '')}>
          <Text className="text-center text-[12px] leading-[16px] text-white" weight="bold">{t('card.hoursClosed')}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" disabled={busy} accessibilityLabel={t('card.hoursUnsure')} onPress={onUnsure} className={cn('min-h-[44px] flex-1 items-center justify-center rounded-xl border border-line bg-white px-[6px]', busy ? 'opacity-50' : '')}>
          <Text className="text-center text-[12px] leading-[16px] text-muk-soft" weight="bold">{t('card.hoursUnsure')}</Text>
        </Pressable>
      </View>
      {error && <Text className="mt-[8px] text-[11px] leading-[15px] text-terracotta" weight="semibold" accessibilityLiveRegion="polite">{t('card.hoursReportFailed')}</Text>}
    </View>
  );
}

function Details({
  model,
  t,
  flash,
  whyOpen,
  setWhyOpen,
  comparisonReason,
  facilityId,
}: {
  model: CardModel;
  t: (k: string, v?: Record<string, string | number>) => string;
  flash: LiveField[];
  whyOpen: boolean;
  setWhyOpen: (v: boolean) => void;
  comparisonReason?: string;
  facilityId: string;
}) {
  const lines = model.openHourLines;
  return (
    <View className="gap-[12px]">
      <View className="flex-row items-center gap-[8px] border-b border-line py-[6px]">
        <Icon icon={MapPin} size="sm" color="gold-deep" />
        <Text className="min-w-0 flex-1 text-[13px] leading-[18px]" weight="extrabold" numberOfLines={1}>{model.title}</Text>
      </View>

      {model.menuTokens.length > 0 && (
        <DetailRow icon={Utensils} label={t('card.signatureMenu')}>
          <View className="mt-[4px] flex-row flex-wrap gap-[4px]">
            {model.menuTokens.map((m) => (
              <View key={m} className="rounded-full bg-gold/10 px-[8px] py-[2px]">
                <Text className="text-[11px] leading-[15px]" weight="semibold">{m}</Text>
              </View>
            ))}
          </View>
        </DetailRow>
      )}

      {lines.length > 0 && (
        <DetailRow icon={Clock} label={t('card.hours')} flash={flash.includes('hours')}>
          {lines.map((line, i) => (
            <Text key={`${i}-${line}`} className="text-[13px] leading-[18px]">
              {line}
              {i === lines.length - 1 && model.hoursExtra.close ? ` ~ ${model.hoursExtra.close}` : ''}
              {i === lines.length - 1 && model.hoursExtra.weekday ? ` (${model.hoursExtra.weekday})` : ''}
            </Text>
          ))}
        </DetailRow>
      )}
      {model.closedDayLines.length > 0 && (
        <DetailRow icon={Clock} label={t('card.closedDays')} flash={flash.includes('hours')}>
          {model.closedDayLines.map((line, i) => (
            <Text key={`${i}-${line}`} className="text-[13px] leading-[18px]">{line}</Text>
          ))}
        </DetailRow>
      )}

      {model.overview && (
        <View className={cn('rounded-lg', flash.includes('overview') ? 'bg-gold/15' : '')}>
          <Text className="mb-[2px] text-[11px] leading-[14px] text-muk-soft" weight="bold">{t('card.about')}</Text>
          <Text className="text-[13px] leading-[20px]" numberOfLines={8} maxFontSizeMultiplier={2}>{model.overview}</Text>
        </View>
      )}

      {model.address && (
        <DetailRow icon={MapPin} label={t('card.address')}>
          <Text className="text-[13px] leading-[19px]">{model.address}</Text>
        </DetailRow>
      )}
      {model.phone && (
        <DetailRow icon={Phone} label={t('card.phone')} flash={flash.includes('phone')}>
          {model.phoneHref ? (
            <Pressable accessibilityRole="link" accessibilityLabel={model.phone} onPress={() => void openPhone(model.phone)} className="min-h-[44px] justify-center">
              <Text className="text-[13px] leading-[18px] text-gold-deep underline" weight="bold">{model.phone}</Text>
            </Pressable>
          ) : (
            <Text className="text-[13px] leading-[18px]">{model.phone}</Text>
          )}
        </DetailRow>
      )}
      {model.homepageUrl && (
        <DetailRow icon={Globe} label={t(model.homepageIsExternalChannel ? 'card.externalChannel' : 'card.website')} flash={flash.includes('homepage')}>
          <Pressable accessibilityRole="link" accessibilityLabel={model.homepageHost ?? model.homepageUrl} onPress={() => void openExternalUrl(model.homepageUrl as string)} className="min-h-[44px] justify-center">
            <Text className="text-[13px] leading-[18px] text-gold-deep underline" weight="bold">{model.homepageHost}</Text>
          </Pressable>
        </DetailRow>
      )}

      <Text className="rounded-2xl border border-gold/25 bg-gold/10 px-[14px] py-[10px] text-[13px] leading-[20px]">{`💡 ${model.reason}`}</Text>

      {model.hasSpot && (
        <Card padded={false} elevation="none">
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: whyOpen }}
            accessibilityLabel={t('card.whyToggle')}
            onPress={() => setWhyOpen(!whyOpen)}
            className="min-h-[44px] flex-row items-center justify-between gap-[8px] rounded-2xl px-[12px] py-[8px]"
          >
            <Text className="text-[12px] leading-[16px]" weight="bold">{t('card.whyToggle')}</Text>
            <Icon icon={whyOpen ? ChevronUp : ChevronDown} size="sm" />
          </Pressable>
          {whyOpen && <WhyPanel model={model} t={t} comparisonReason={comparisonReason} />}
        </Card>
      )}

      <GoldenHourLine facilityId={facilityId} />
      <DayForecast facilityType={model.type} enabled />
    </View>
  );
}

function WhyPanel({
  model,
  t,
  comparisonReason,
}: {
  model: CardModel;
  t: (k: string, v?: Record<string, string | number>) => string;
  comparisonReason?: string;
}) {
  const { times } = model;
  const a = model.area;
  return (
    <View className="gap-[12px] border-t border-line px-[12px] pb-[12px] pt-[12px]">
      {comparisonReason && (
        <View className="rounded-xl border border-jade/20 bg-jade/5 px-[12px] py-[8px]">
          <Text className="text-[10px] leading-[14px] text-jade" weight="extrabold">{t('recommend.spotComparison.current')}</Text>
          <Text className="mt-[2px] text-[11px] leading-[16px]" weight="semibold">{comparisonReason}</Text>
        </View>
      )}
      <View className="flex-row gap-[8px]">
        <View className="min-w-0 flex-1 justify-center rounded-2xl border border-gold/20 bg-gold/10 p-[12px]">
          <Text className="mb-[4px] text-[10px] leading-[13px] text-muk-soft" weight="semibold">{t(times.waitMin !== null ? 'card.totalTime' : 'card.walkTime')}</Text>
          <Text className="text-[24px] leading-[28px]" weight="black">
            {times.totalMin}
            <Text className="text-[12px] text-muk-soft" weight="medium">{` ${t('card.minute')}`}</Text>
          </Text>
          {times.waitMin !== null && (
            <View className="mt-[6px] flex-row flex-wrap items-center gap-[6px]">
              <Text className="rounded bg-gold/15 px-[6px] py-[2px] text-[10px] leading-[13px] text-gold-deep">{t('card.wait', { n: times.waitMin })}</Text>
              <Text className="text-[10px] text-muk-soft">+</Text>
              <Text className="rounded bg-jade/15 px-[6px] py-[2px] text-[10px] leading-[13px] text-jade">{t('card.travel', { n: times.walkMin })}</Text>
            </View>
          )}
        </View>
        <View className="w-[110px] items-center justify-center rounded-2xl border border-line bg-hanji-deep p-[12px]">
          <Text className="mb-[4px] text-[10px] leading-[13px] text-muk-soft" weight="semibold">{t('card.prefMatch')}</Text>
          <Text className="text-[22px] leading-[26px] text-jade" weight="black">{model.preferencePercent ?? '–'}<Text className="text-[12px] text-jade">%</Text></Text>
          <Text className="mt-[2px] text-center text-[10px] leading-[13px] text-muk-soft">{t('card.prefBasis')}</Text>
        </View>
      </View>

      {(model.freshnessStamp || model.remaining || model.availabilityLine || (model.crowdChip && !model.crowdChipOnFace)) && (
        <View className="flex-row flex-wrap items-center gap-[6px]">
          {model.crowdChip && !model.crowdChipOnFace && (
            <View className="rounded-md border border-line bg-white/70 px-[8px] py-[2px]">
              <Text className="text-[10px] leading-[14px]" weight="bold">{model.crowdChip.text}</Text>
            </View>
          )}
          {model.freshnessStamp && (
            <View className="rounded-md border border-dashed border-line px-[8px] py-[2px]">
              <Text className="text-[10px] leading-[14px] text-muk-soft" weight="medium">{model.freshnessStamp}</Text>
            </View>
          )}
          {model.remaining && (
            <Text className="rounded-md border border-line bg-hanji-deep px-[8px] py-[2px] text-[10px] leading-[14px] text-muk-soft">
              {`${t('card.remainingLabel')}: ${t('card.remainingValue', model.remaining)}`}
            </Text>
          )}
          {model.availabilityLine && (
            <Text className="rounded-md border border-jade/25 bg-jade/10 px-[8px] py-[2px] text-[10px] leading-[14px] text-jade" weight="semibold">{model.availabilityLine}</Text>
          )}
        </View>
      )}
      {model.licenseLine && <Text className="text-[10px] leading-[14px] text-muk-soft">{model.licenseLine}</Text>}

      {a && (
        <View className="rounded-xl border border-gold/20 bg-gold/5 px-[12px] py-[8px]">
          <View className="flex-row items-center justify-between gap-[8px]">
            <Text className="min-w-0 flex-1 text-[11px] leading-[15px]" weight="bold">{a.title}</Text>
            {a.mode && <Text className="text-[10px] leading-[14px] text-muk-soft">{a.mode}</Text>}
          </View>
          {a.action && <Text className="mt-[6px] text-[11px] leading-[16px]" weight="extrabold">{a.action}</Text>}
          {a.rank && <Text className="mt-[4px] text-[11px] leading-[16px]">{a.rank}</Text>}
          {a.delayed && <Text className="mt-[4px] text-[11px] leading-[16px]">{a.delayed}</Text>}
          {a.compositeHint && <Text className="mt-[4px] text-[11px] leading-[16px] text-muk-soft">{t('recommend.areaDemandCompositeHint')}</Text>}
          {a.parking && (
            <View className="mt-[8px] rounded-lg border border-line bg-white/55 px-[10px] py-[8px]">
              <Text className="text-[11px] leading-[15px]" weight="bold">{a.parking.title}</Text>
              <Text className="mt-[2px] text-[10px] leading-[14px] text-muk-soft">{a.parking.sub}</Text>
            </View>
          )}
          {a.tourism && (
            <View className="mt-[8px] rounded-lg border border-line bg-white/55 px-[10px] py-[8px]">
              <Text className="text-[11px] leading-[15px]" weight="bold">{a.tourism.title}</Text>
              <Text className="mt-[2px] text-[10px] leading-[14px] text-muk-soft">{a.tourism.sub}</Text>
              <Text className="mt-[4px] text-[10px] leading-[14px] text-muk-soft">{a.tourism.disclaimer}</Text>
            </View>
          )}
          {a.sources && <Text className="mt-[4px] text-[10px] leading-[14px] text-muk-soft">{a.sources}</Text>}
          {a.confidence && <Text className="mt-[4px] text-[10px] leading-[14px] text-muk-soft">{a.confidence}</Text>}
        </View>
      )}
      {model.eventLine && (
        <Text className="rounded-xl border border-terracotta/20 bg-terracotta/10 px-[12px] py-[8px] text-[11px] leading-[16px] text-terracotta">{model.eventLine}</Text>
      )}
    </View>
  );
}

