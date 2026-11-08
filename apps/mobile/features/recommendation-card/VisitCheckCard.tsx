import { Check, MapPin, ThumbsDown, ThumbsUp, X } from 'lucide-react-native';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, View } from 'react-native';

import { Button, Card, Icon, IconButton, Pressable, Text, cn, toast } from '~/components/ui';
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

import {
  completeVisit,
  dismissVisitCheck,
  DUE_AFTER_MS,
  getDueVisit,
  getPendingVisit,
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
  className?: string;
  /** 방문을 마친 뒤 '쿠폰함 보기' 로 간다. 없으면 그 버튼을 그리지 않는다(쿠폰은 경주 가게만 준다 — 앱 v1 은 경주만이라 홈이 넘기면 된다). */
  onOpenCoupons?: () => void;
  /** 그릴 것이 생기거나 없어질 때(때가 된 방문 — 답하는 중 · 고마워요 단계 포함) — 홈이 카드 자리를 고른다. */
  onActiveChange?: (active: boolean) => void;
}

/** 혼잡 한 번 탭 → 서버 계약 값 · 문구 키. 웹 VisitCheckCard 와 같다. */
const CONGESTION: readonly [ObservedCongestion, string, string][] = [
  ['quiet', 'congestion.quiet', 'report.quietDesc'],
  ['normal', 'congestion.moderate', 'report.moderateDesc'],
  ['busy', 'congestion.busy', 'report.busyDesc'],
];

/**
 * 방문 확인 카드 — 수락(길안내 시작) 30분 뒤(또는 '도착했어요' 직후) '○○ 다녀오셨나요?' → 예 → 체감 혼잡 한 번 탭 → 👍/👎 → 방문 이력.
 * 웹 components/main/VisitCheckCard.tsx(기준 커밋 0d145a1). 체감 혼잡은 가입 계정만 지도 혼잡에 바로 반영되고 게스트는 그림자 저장이라
 * 안내 문구가 다르다(웹과 같은 규칙). 단계 판정·저장은 tripLoop.
 */
export function VisitCheckCard({ className, onOpenCoupons, onActiveChange }: VisitCheckCardProps) {
  const t = useT();
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

  // 서버가 이번 혼잡 답을 저장하지 않았을 때(게스트의 같은 네트워크·쿨다운 등) 중립 문장을 단다. 카드를 이미 닫았으면 알림으로.
  useEffect(
    () =>
      appEvents.on('crowd-answer', (detail) => {
        if (!detail || detail.recommendationId !== awaitingFor.current) return;
        awaitingFor.current = null;
        if (!isUnrecordedCrowdAnswer(detail.crowdAnswer)) return;
        if (cardOpen.current) setNotRecorded(true);
        else toast(t('visit.congestionNotRecorded'));
      }),
    [t],
  );

  // 다시 볼 때: 화면에 돌아올 때(탭 전환·다른 화면에서 뒤로) · 앱이 앞으로 올 때 · 도착/길안내 알림 · 30분이 차는 순간(타이머).
  // 타이머가 없으면 홈을 켜 둔 채 30분이 지나도 카드가 뜨지 않았다.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const check = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const now = Date.now();
    const d = getDueVisit(now);
    setDue(d);
    if (!d) {
      setStage('ask');
      cardOpen.current = false;
      const pending = getPendingVisit();
      if (pending) {
        // 30분 시점까지 남은 만큼 기다렸다가 다시 본다(+1초 여유 — 경계에서 한 번 더 비지 않게).
        const wait = Math.max(0, pending.acceptedAt + DUE_AFTER_MS - now) + 1000;
        timerRef.current = setTimeout(check, wait);
      }
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
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
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
    toast(t('visit.thanks'));
    setStage(nextVisitStage('feedback', 'rate', asksCrowd));
  };

  const activeIndex = steps.indexOf(stage);
  // 자리가 좁을 때 쓰던 접은 판은 없다 — 판은 하나이고, 홈이 남은 높이 안에서 스크롤로 위쪽부터 보여 준다.
  // 그래서 단계마다 질문 한 줄과 답 버튼을 맨 위에 두고, 설명 · 단계 점은 그 아래에 둔다(homeModel TRIP_CARD_HEIGHT.visit).
  return (
    <Card elevation="surface" className={cn('rounded-3xl', className ?? '')} accessibilityLabel={t('visit.askDesc')}>
      <View className="absolute right-[4px] top-[4px] z-10">
        <IconButton icon={X} accessibilityLabel={t('common.close')} onPress={stage === 'completed' ? () => { haptic('selection'); close(); } : dismiss} size="md" />
      </View>

      {stage === 'completed' ? (
        <View className="gap-[12px] pr-[24px]" testID="visit-completed">
          <View className="flex-row items-start gap-[10px]">
            <View className="h-[36px] w-[36px] items-center justify-center rounded-full bg-jade">
              <Icon icon={Check} size="lg" color="white" />
            </View>
            <View className="min-w-0 flex-1">
              <Text className="text-[14px] leading-[20px]" weight="bold">{t('visit.thanks')}</Text>
              <Text className="mt-[4px] text-[11px] leading-[16px] text-muk-soft">{t('visit.askDesc')}</Text>
              {notRecorded && <Text className="mt-[4px] text-[11px] leading-[16px] text-muk-soft" accessibilityLiveRegion="polite">{t('visit.congestionNotRecorded')}</Text>}
            </View>
          </View>
          {onOpenCoupons && <Button label={t('mypage.menuCoupons')} onPress={onOpenCoupons} />}
          <Pressable accessibilityRole="button" accessibilityLabel={t('common.close')} onPress={() => { haptic('selection'); close(); }} className="min-h-[44px] items-center justify-center">
            <Text className="text-[12px] text-muk-soft" weight="bold">{t('common.close')}</Text>
          </Pressable>
        </View>
      ) : stage === 'ask' ? (
        <View className="gap-[12px] pr-[24px]">
          <View className="flex-row items-start gap-[8px]">
            <View className="pt-[2px]" accessibilityElementsHidden importantForAccessibility="no">
              <Icon icon={MapPin} size="sm" color="jade" />
            </View>
            <Text className="min-w-0 flex-1 text-[14px] leading-[20px]" weight="bold" accessibilityRole="header">{t('visit.askTitle', { name: due.name })}</Text>
          </View>
          <View className="flex-row gap-[8px]">
            <Button className="flex-1" variant="secondary" label={t('visit.notYet')} onPress={dismiss} />
            <Button className="flex-1" label={t('visit.yes')} onPress={confirmArrival} />
          </View>
          <Text className="text-[11px] leading-[16px] text-muk-soft">{t('visit.askDesc')}</Text>
        </View>
      ) : stage === 'feedback' ? (
        <View className="gap-[12px] pr-[24px]">
          <View>
            <Text className="text-[14px] leading-[20px]" weight="bold" numberOfLines={1}>{due.name}</Text>
            <Text className="mt-[2px] text-[11px] leading-[16px] text-muk-soft">{t('visit.feedbackTitle')}</Text>
          </View>
          <View className="flex-row gap-[8px]">
            <Button className="flex-1" variant="secondary" icon={ThumbsDown} label={t('visit.disliked')} onPress={() => rate('down')} />
            <Button className="flex-1" icon={ThumbsUp} label={t('visit.liked')} onPress={() => rate('up')} />
          </View>
        </View>
      ) : (
        <View className="gap-[12px] pr-[24px]">
          <Text className="text-[14px] leading-[20px]" weight="bold">{t('report.title')}</Text>
          <View className="flex-row gap-[8px]">
            {CONGESTION.map(([value, labelKey, descKey]) => (
              <Pressable
                key={value}
                accessibilityRole="button"
                accessibilityLabel={`${t(labelKey)}. ${t(descKey)}`}
                onPress={() => pickCongestion(value)}
                className="min-h-[60px] flex-1 items-center justify-center rounded-2xl border border-line bg-hanji-deep px-[4px] py-[8px]"
              >
                <Text className="text-[13px] leading-[17px]" weight="bold">{t(labelKey)}</Text>
                <Text className="mt-[2px] text-center text-[10px] leading-[13px] text-muk-soft">{t(descKey)}</Text>
              </Pressable>
            ))}
          </View>
          <Text className="text-[11px] leading-[16px] text-muk-soft">{t(isGuest ? 'visit.guestCongestionNote' : 'report.footer')}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={t('common.close')} onPress={() => pickCongestion()} className="min-h-[44px] items-center justify-center">
            <Text className="text-[12px] text-muk-soft" weight="bold">{t('common.close')}</Text>
          </Pressable>
        </View>
      )}

      {stage !== 'completed' && (
        <View className="mt-[12px] flex-row gap-[6px]" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {steps.map((item, index) => (
            <View key={item} className={cn('h-[6px] rounded-full', index <= activeIndex ? 'bg-jade' : 'bg-line')} style={{ width: index === activeIndex ? 28 : 10 }} />
          ))}
        </View>
      )}
    </Card>
  );
}
