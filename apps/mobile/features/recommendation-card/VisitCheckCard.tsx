import { Check, MapPin, ThumbsDown, ThumbsUp, X } from 'lucide-react-native';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, View, type StyleProp, type ViewStyle, Platform } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

import { Gradient, Icon, IconButton, Pressable, Text, cn, toast, useReduceMotion } from '~/components/ui';
import { useAccount } from '~/lib/core/account';
import { appEvents } from '~/lib/core/events';
import {
  isUnrecordedCrowdAnswer,
  queueRecommendationOutcome,
  type ObservedCongestion,
  type OutcomeRating,
} from '~/lib/core/recommendationOutcomes';
import { haptic } from '~/lib/platform/haptics';
import { track, trackEvent } from '~/lib/platform/analytics';
import { springs } from '~/lib/theme/tokens';

import {
  completeVisit,
  dismissVisitCheck,
  getDueVisit,
  isGuestAccount,
  nextVisitStage,
  ratedOutcomeFields,
  tripEvents,
  visitSteps,
  type PendingVisit,
  type VisitStage,
} from './tripLoop';
import { useT } from '~/lib/i18n/I18nProvider';

export interface VisitCheckCardProps {
  /** 위치·크기(홈이 지도 위에 띄운다). */
  className?: string;
  /** 위치를 계산값으로 줄 때(예: bottom: NAV_GAP + 8, 가운데 maxWidth 384) — 바깥 상자에 붙는다. */
  style?: StyleProp<ViewStyle>;
  /** 방문을 마친 뒤 '쿠폰함 보기' 로 간다. 없으면 그 버튼을 그리지 않는다(쿠폰은 경주 가게만 준다 — 앱 v1 은 경주만이라 홈이 넘기면 된다). */
  onOpenCoupons?: () => void;
  /** 그릴 것이 생기거나 없어질 때(때가 된 방문 — 답하는 중 · 고마워요 단계 포함) — 홈이 카드 자리를 고른다. */
  onActiveChange?: (active: boolean) => void;
  /**
   * '고마워요'·'혼잡 답은 기록하지 않았어요' 알림을 띄우는 곳 — 웹은 홈 알약 토스트(showToast)로 보낸다(G3-33).
   * 없으면 앱 공용 토스트(sonner)로.
   */
  onToast?: (message: string) => void;
}

/** 혼잡 한 번 탭 → 서버 계약 값 · 문구 키. 웹 VisitCheckCard 와 같다. */
const CONGESTION: readonly [ObservedCongestion, string, string][] = [
  ['quiet', 'congestion.quiet', 'report.quietDesc'],
  ['normal', 'congestion.moderate', 'report.moderateDesc'],
  ['busy', 'congestion.busy', 'report.busyDesc'],
];

// 토큰 요청 중(lib/theme/tokens shadows) — 웹 VisitCheckCard 의 임의 그림자 두 개.
/** 판 — shadow-[0_8px_30px_rgba(43,35,32,0.16)]. */
const CARD_SHADOW = '0px 8px 30px rgba(43, 35, 32, 0.16)';
/** 웹 backdrop-blur-2xl(40px) — 웹 빌드만(뒤의 카드 버튼이 비치지 않게). 네이티브는 흰 95% 그대로. */
const WEB_BLUR = Platform.OS === 'web' ? ({ backdropFilter: 'blur(40px)' } as object) : null;
/** '네, 다녀왔어요' — shadow-[0_4px_14px_rgba(193,85,59,0.25)]. */
const YES_SHADOW = '0px 4px 14px rgba(193, 85, 59, 0.25)';
/** 위 2px 장식선 — 웹 from-transparent via-jade/50 to-transparent(투명 끝도 jade 로 둬 회색이 끼지 않게). */
const TOP_LINE_COLORS = ['rgba(62, 124, 106, 0)', 'rgba(62, 124, 106, 0.5)', 'rgba(62, 124, 106, 0)'] as const;

/** 웹 text-[11px] leading-snug(1.375) = 15.125px. */
const LEADING_11_SNUG = 'leading-[15.125px]';
/** 웹 text-sm leading-snug = 19.25px. */
const LEADING_14_SNUG = 'leading-[19.25px]';

/** py-2.5 · 12px 버튼(보이는 높이 36) — 탭 영역 44. */
const BUTTON_SLOP = { top: 4, bottom: 4, left: 0, right: 0 };
/** '닫기' 글자 버튼(16) — 탭 영역 44. */
const TEXT_BUTTON_SLOP = { top: 14, bottom: 14, left: 0, right: 0 };

/**
 * 방문 확인 카드 — 수락(길안내 시작) 30분 뒤(또는 '도착했어요' 직후) '○○ 다녀오셨나요?' → 예 → 체감 혼잡 한 번 탭 → 👍/👎 → 방문 이력.
 * 웹 components/main/VisitCheckCard.tsx 가 기준이다(판·단계 점·단계별 구성 — G3-31). 체감 혼잡은 가입 계정만 지도 혼잡에 바로
 * 반영되고 게스트는 그림자 저장이라 안내 문구가 다르다(웹과 같은 규칙). 단계 판정·저장은 tripLoop.
 * 다시 보는 때는 웹처럼(G3-32 나): 처음 붙을 때 · 화면에 돌아올 때 · 앱이 앞으로 올 때 · 도착/길안내 알림. 30분 타이머는 없다.
 */
export function VisitCheckCard({ className, style, onOpenCoupons, onActiveChange, onToast }: VisitCheckCardProps) {
  const t = useT();
  const reduceMotion = useReduceMotion();
  const { account } = useAccount();
  const isGuest = isGuestAccount(account);
  const asksCrowd = true; // 앱 v1 은 경주만 — 혼잡 제보가 켜진 지역
  const steps = visitSteps(asksCrowd);
  const [due, setDue] = useState<PendingVisit | null>(null);
  const [stage, setStage] = useState<VisitStage>('ask');
  const [observed, setObserved] = useState<ObservedCongestion | null>(null);
  const [notRecorded, setNotRecorded] = useState(false);
  const awaitingFor = useRef<string | null>(null);
  const cardOpen = useRef(false);

  const onToastRef = useRef(onToast);
  onToastRef.current = onToast;
  const notify = useCallback((message: string) => {
    const show = onToastRef.current;
    if (show) show(message);
    else toast(message);
  }, []);

  // 서버가 이번 혼잡 답을 저장하지 않았을 때(게스트의 같은 네트워크·쿨다운 등) 중립 문장을 단다. 카드를 이미 닫았으면 알림으로.
  useEffect(
    () =>
      appEvents.on('crowd-answer', (detail) => {
        if (!detail || detail.recommendationId !== awaitingFor.current) return;
        awaitingFor.current = null;
        if (!isUnrecordedCrowdAnswer(detail.crowdAnswer)) return;
        if (cardOpen.current) setNotRecorded(true);
        else notify(t('visit.congestionNotRecorded'));
      }),
    [t, notify],
  );

  // 다시 볼 때: 처음 붙을 때 · 화면에 돌아올 때(탭 전환·다른 화면에서 뒤로) · 앱이 앞으로 올 때 · 도착/길안내 알림.
  const check = useCallback(() => {
    const d = getDueVisit(Date.now());
    setDue(d);
    if (!d) {
      setStage('ask');
      cardOpen.current = false;
    }
  }, []);

  useEffect(() => {
    check();
    const sub = AppState.addEventListener('change', (s) => s === 'active' && check());
    const offArrived = tripEvents.on('trip-arrived', check);
    const offNavigating = tripEvents.on('trip-navigating', check);
    return () => {
      sub.remove();
      offArrived();
      offNavigating();
    };
  }, [check]);

  useFocusEffect(
    useCallback(() => {
      check();
    }, [check]),
  );

  const onActiveChangeRef = useRef(onActiveChange);
  onActiveChangeRef.current = onActiveChange;
  const isActive = due !== null;
  useEffect(() => {
    onActiveChangeRef.current?.(isActive);
  }, [isActive]);

  // 등장 — 웹 initial {opacity 0, y 24} → sheetSpring.
  const enter = useSharedValue(0);
  useEffect(() => {
    if (!isActive) {
      enter.value = 0;
      return;
    }
    enter.value = reduceMotion ? 1 : withSpring(1, springs.sheet);
  }, [isActive, reduceMotion, enter]);
  const enterStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, enter.value),
    transform: [{ translateY: 24 * (1 - enter.value) }],
  }));

  // 단계 전환 — 웹 initial {opacity 0, x 18, scale .99} → interactionSpring(나가는 쪽 x −14 는 옮기지 않았다).
  const stageIn = useSharedValue(1);
  const firstStage = useRef(true);
  useEffect(() => {
    if (firstStage.current || reduceMotion) {
      firstStage.current = false;
      stageIn.value = 1;
      return;
    }
    stageIn.value = 0;
    stageIn.value = withSpring(1, springs.interaction);
  }, [stage, reduceMotion, stageIn]);
  const stageStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, stageIn.value),
    transform: [{ translateX: 18 * (1 - stageIn.value) }, { scale: 0.99 + 0.01 * stageIn.value }],
  }));

  if (!due) return null;

  const close = () => {
    cardOpen.current = false;
    setNotRecorded(false);
    setDue(null);
    setStage('ask');
  };
  // 닫기 — 대기 방문과 진행 중 여정을 함께 지워 루프를 끝낸다(다시 열어도 되살아나지 않는다). 진행 카드도 같이 사라지도록 알린다.
  const dismiss = () => {
    haptic('selection');
    dismissVisitCheck();
    tripEvents.emit('trip-navigating', undefined);
    close();
  };
  const confirmArrival = () => {
    trackEvent('visit_arrived', { facility_id: String(due.facilityId).slice(0, 64), type: due.type ?? null });
    haptic('confirm');
    queueRecommendationOutcome(due.recommendationId, 'arrival_confirmed');
    setObserved(null);
    setStage(nextVisitStage('ask', 'confirm', asksCrowd));
  };
  const pickCongestion = (value?: ObservedCongestion) => {
    trackEvent('visit_congestion', { level: value ?? null });
    haptic(value ? 'confirm' : 'selection');
    setObserved(value ?? null);
    setStage(nextVisitStage('congestion', value ? 'pick_congestion' : 'skip_congestion', asksCrowd));
  };
  const rate = (rating: OutcomeRating) => {
    haptic('confirm');
    completeVisit({ facilityId: due.facilityId, name: due.name, type: due.type, rating });
    const fields = ratedOutcomeFields(rating, observed, asksCrowd);
    awaitingFor.current = fields.observedCongestion && due.recommendationId ? due.recommendationId : null;
    cardOpen.current = true;
    setNotRecorded(false);
    queueRecommendationOutcome(due.recommendationId, 'rated', fields);
    track('visit_confirmed', { facility_type: due.type, rating });
    haptic('success');
    notify(t('visit.thanks'));
    setStage(nextVisitStage('feedback', 'rate', asksCrowd));
  };

  const activeIndex = steps.indexOf(stage);
  const closeCompleted = () => { haptic('selection'); close(); };

  // 웹 판: relative bg-white/95 border-line rounded-3xl p-4 shadow + 위 2px 장식선. 그림자는 바깥 상자(잘리지 않게),
  // 둥근 모서리 자르기는 안쪽 상자에 둔다(안드로이드는 overflow hidden 상자의 그림자를 자른다).
  return (
    <View className={className} style={style}>
      <Animated.View style={enterStyle}>
        <View
          accessibilityLabel={t('visit.askDesc')}
          className="rounded-3xl border border-line bg-white/95"
          style={[{ boxShadow: CARD_SHADOW }, WEB_BLUR]}
        >
          <View className="overflow-hidden rounded-[23px] p-[16px]">
            <Gradient
              colors={TOP_LINE_COLORS}
              start={{ x: 0, y: 0.5 }}
              end={{ x: 1, y: 0.5 }}
              pointerEvents="none"
              style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2 }}
            />

            {stage !== 'completed' && (
              <View className="mb-[12px] flex-row gap-[6px] pr-[32px]" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                {steps.map((item, index) => (
                  <StepDot key={item} done={index <= activeIndex} current={index === activeIndex} reduceMotion={reduceMotion} />
                ))}
              </View>
            )}

            <Animated.View style={stageStyle}>
              {stage === 'completed' ? (
                <View className="gap-[12px] pr-[24px]" testID="visit-completed">
                  <View className="flex-row items-start gap-[10px]">
                    <CompletedBadge reduceMotion={reduceMotion} />
                    <View className="min-w-0 flex-1">
                      <Text className="text-[14px] leading-[20px]" weight="bold">{t('visit.thanks')}</Text>
                      <Text className={cn('mt-[4px] text-[11px] text-muk-soft', LEADING_11_SNUG)}>{t('visit.askDesc')}</Text>
                      {notRecorded && (
                        <Text className={cn('mt-[4px] text-[11px] text-muk-soft', LEADING_11_SNUG)} accessibilityLiveRegion="polite">
                          {t('visit.congestionNotRecorded')}
                        </Text>
                      )}
                    </View>
                  </View>
                  {onOpenCoupons && (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('mypage.menuCoupons')}
                      onPress={onOpenCoupons}
                      hitSlop={BUTTON_SLOP}
                      className="items-center justify-center rounded-2xl bg-jade py-[10px]"
                    >
                      <Text className="text-center text-[12px] leading-[16px] text-white" weight="bold">{t('mypage.menuCoupons')}</Text>
                    </Pressable>
                  )}
                  <TextButton label={t('common.close')} onPress={closeCompleted} />
                </View>
              ) : stage === 'ask' ? (
                <View className="gap-[12px] pr-[24px]">
                  <View className="flex-row items-start gap-[10px]">
                    <View
                      className="h-[36px] w-[36px] items-center justify-center rounded-full border border-jade/25 bg-jade/10"
                      accessibilityElementsHidden
                      importantForAccessibility="no-hide-descendants"
                    >
                      <Icon icon={MapPin} size={18} color="jade" />
                    </View>
                    <View className="min-w-0 flex-1">
                      <Text className={cn('text-[14px]', LEADING_14_SNUG)} weight="bold" accessibilityRole="header">
                        {t('visit.askTitle', { name: due.name })}
                      </Text>
                      <Text className={cn('mt-[2px] text-[11px] text-muk-soft', LEADING_11_SNUG)}>{t('visit.askDesc')}</Text>
                    </View>
                  </View>
                  <View className="flex-row gap-[8px]">
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('visit.notYet')}
                      onPress={dismiss}
                      hitSlop={BUTTON_SLOP}
                      className="flex-1 items-center justify-center rounded-2xl border border-line bg-hanji-deep py-[10px]"
                    >
                      <Text className="text-center text-[12px] leading-[16px] text-muk-soft" weight="bold">{t('visit.notYet')}</Text>
                    </Pressable>
                    {/* 웹 from-gold to-terracotta 는 흰 글자 대비가 모자라 앱은 cta 토큰(D2 b②). */}
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('visit.yes')}
                      onPress={confirmArrival}
                      hitSlop={BUTTON_SLOP}
                      className="flex-1 items-center justify-center rounded-2xl py-[10px]"
                      style={{ boxShadow: YES_SHADOW }}
                    >
                      <Gradient name="cta" pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 16 }} />
                      <Text className="text-center text-[12px] leading-[16px] text-white" weight="bold">{t('visit.yes')}</Text>
                    </Pressable>
                  </View>
                </View>
              ) : stage === 'feedback' ? (
                <View className="gap-[12px] pr-[24px]">
                  <View className="min-w-0">
                    <Text className={cn('text-[14px]', LEADING_14_SNUG)} weight="bold" numberOfLines={1}>{due.name}</Text>
                    <Text className={cn('mt-[2px] text-[11px] text-muk-soft', LEADING_11_SNUG)}>{t('visit.feedbackTitle')}</Text>
                  </View>
                  {/* 👍/👎 — 어느 쪽이든 방문 확정(이력 적립 + 대기 방문 지움). */}
                  <View className="flex-row gap-[8px]">
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('visit.disliked')}
                      onPress={() => rate('down')}
                      hitSlop={BUTTON_SLOP}
                      className="flex-1 flex-row items-center justify-center gap-[6px] rounded-2xl border border-line bg-hanji-deep py-[10px]"
                    >
                      <Icon icon={ThumbsDown} size="sm" color="muk-soft" />
                      <Text className="text-[12px] leading-[16px] text-muk-soft" weight="bold">{t('visit.disliked')}</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('visit.liked')}
                      onPress={() => rate('up')}
                      hitSlop={BUTTON_SLOP}
                      className="flex-1 flex-row items-center justify-center gap-[6px] rounded-2xl border border-jade/40 bg-jade/15 py-[10px]"
                    >
                      <Icon icon={ThumbsUp} size="sm" color="jade" />
                      <Text className="text-[12px] leading-[16px] text-jade" weight="bold">{t('visit.liked')}</Text>
                    </Pressable>
                  </View>
                </View>
              ) : (
                <View className="gap-[12px] pr-[24px]">
                  <View>
                    <Text className="text-[14px] leading-[20px]" weight="bold">{t('report.title')}</Text>
                    {/* 웹 text-[11px] 은 줄 높이를 물려받는다(1.5 → 16.5px). */}
                    <Text className="mt-[2px] text-[11px] leading-[16.5px] text-muk-soft" testID="visit-congestion-note">
                      {t(isGuest ? 'visit.guestCongestionNote' : 'report.footer')}
                    </Text>
                  </View>
                  <View className="flex-row gap-[8px]">
                    {CONGESTION.map(([value, labelKey, descKey]) => (
                      <Pressable
                        key={value}
                        accessibilityRole="button"
                        accessibilityLabel={`${t(labelKey)}. ${t(descKey)}`}
                        onPress={() => pickCongestion(value)}
                        className="flex-1 items-center justify-center rounded-2xl border border-line bg-hanji-deep px-[8px] py-[8px]"
                      >
                        <Text className="text-center text-[12px] leading-[16px]" weight="bold">{t(labelKey)}</Text>
                        <Text className="mt-[2px] text-center text-[10px] leading-[13.33px] text-muk-soft">{t(descKey)}</Text>
                      </Pressable>
                    ))}
                  </View>
                  <TextButton label={t('common.close')} onPress={() => pickCongestion()} />
                </View>
              )}
            </Animated.View>

            {/* 닫기 — 웹 absolute top-3 right-3 p-1 · X 16. 보이는 상자 24, 탭 영역은 hitSlop 으로 44. */}
            <View className="absolute right-[12px] top-[12px]">
              <IconButton
                icon={X}
                size="md"
                box={24}
                color="muk-soft"
                accessibilityLabel={t('common.close')}
                onPress={stage === 'completed' ? closeCompleted : dismiss}
              />
            </View>
          </View>
        </View>
      </Animated.View>
    </View>
  );
}

/** 글자만 있는 버튼('닫기') — 웹 text-xs font-bold text-muk-soft. */
function TextButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={TEXT_BUTTON_SLOP} className="items-center justify-center">
      <Text className="text-[12px] leading-[16px] text-muk-soft" weight="bold">{label}</Text>
    </Pressable>
  );
}

/** 단계 점 — 웹 h-1.5 rounded-full, 현재 28 · 나머지 10(폭은 interactionSpring). */
function StepDot({ done, current, reduceMotion }: { done: boolean; current: boolean; reduceMotion: boolean }) {
  const target = current ? 28 : 10;
  const width = useSharedValue(target);
  useEffect(() => {
    width.value = reduceMotion ? target : withSpring(target, springs.interaction);
  }, [target, reduceMotion, width]);
  const animated = useAnimatedStyle(() => ({ width: width.value }));
  return (
    <Animated.View style={[{ height: 6, borderRadius: 3, overflow: 'hidden' }, animated]}>
      <View className={done ? 'flex-1 bg-jade' : 'flex-1 bg-line'} />
    </Animated.View>
  );
}

/** 완료 표 — 36px jade 원 · Check 18. 웹 initial {scale 0, rotate −18°} → sheetSpring. */
function CompletedBadge({ reduceMotion }: { reduceMotion: boolean }) {
  const p = useSharedValue(reduceMotion ? 1 : 0);
  useEffect(() => {
    p.value = reduceMotion ? 1 : withSpring(1, springs.sheet);
  }, [reduceMotion, p]);
  const animated = useAnimatedStyle(() => ({
    transform: [{ scale: p.value }, { rotate: `${-18 * (1 - p.value)}deg` }],
  }));
  return (
    <Animated.View style={animated}>
      <View className="h-[36px] w-[36px] items-center justify-center rounded-full bg-jade" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Icon icon={Check} size={18} color="white" />
      </View>
    </Animated.View>
  );
}
