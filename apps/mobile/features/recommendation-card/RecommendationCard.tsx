// 추천 카드 — 웹 components/RecommendationCard.tsx(기준 yunseong, 2026-11-11)의 '지도 위에 뜬 카드' 모델을 그대로 옮긴다(G3-01).
//
// 웹 모델: 미리보기(짧은 판) → 전체(위쪽 스크롤 영역 + 바닥 고정 버튼 두 줄) → 상세(전체 카드 스크롤 안에 덧붙임).
// 높이 3단 시트가 아니다 — 카드 높이는 늘 내용 높이(최대 maxHeight)이고, 손잡이 글자 버튼 · 탭 · 끌기(한 칸씩)로 바꾼다.
// 11-09 의 '이어 보이기' 바텀시트(RecommendationSheet)는 11-10 결정(웹에 맞춘다)으로 이 카드로 바뀐다 — 홈 연결은 H3a.
//
// 바로잡은 설계(docs/parity/review-R2.md §2 G3-01):
// - 틀은 두 겹 — 바깥은 그림자·둥글기, 안쪽은 overflow hidden(안드로이드는 같은 View 의 overflow 가 그림자를 자른다).
// - 끌기(Pan)는 손잡이 · 미리보기 · 바닥 버튼 줄 세 곳에만 붙인다(감지기마다 makePan()). 스크롤 영역은 감싸지 않는다 —
//   스크롤 영역 안 끌기는 스크롤만 한다(웹 실기기에서도 .rec-scroll 이 세로 이동을 먼저 갖는다).
// - ScrollView 는 flexGrow 0 · flexShrink 1(기본 flexGrow 1 이면 최대 높이까지 늘거나 0 으로 접힌다).
// - 가장자리 흐림은 더 볼 내용이 있을 때만.
// - 상태·행동 함수(수락 · 킵 · 거절 · 영업 확인 · 실시간 새로고침)는 RecommendationSheet 의 CardBody 에서 옮겼다.
import { useFocusEffect } from 'expo-router';
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
  X,
} from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AppState,
  BackHandler,
  Platform,
  ScrollView,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  FadeIn,
  LinearTransition,
  ReduceMotion,
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useNavInsets } from '~/components/navigation/navMetrics';
import { ErrorState, Gradient, Icon, Pressable, Skeleton, Text, cn, toast, useReduceMotion } from '~/components/ui';
import { RingSpinner } from '~/components/ui/RingSpinner';
import { apiClient, reportFacilityAvailability, type TravelContext } from '~/lib/core/apiClient';
import { useBusyThreshold } from '~/lib/core/publicSettings';
import { useI18n, useT } from '~/lib/i18n/I18nProvider';
import { trackEvent, usageCardProps } from '~/lib/platform/analytics';
import { haptic } from '~/lib/platform/haptics';
import { openExternalUrl, openPhone } from '~/lib/platform/links';
import { colors, shadows, springs } from '~/lib/theme/tokens';
import { LIVE_FLASH_MS, LIVE_REFRESH_COOLDOWN_MS, refreshedFields, type LiveField } from '@/lib/liveDetailDiff';
import { nextSheetState, sheetElastic, type SheetState } from '@/lib/sheetSnap';

import { acceptCandidate, keepCandidate, rejectCandidate, type NavigationMode, type NotifyFn } from './actions';
import { nextAfterKeep, nextCandidateAfter } from './actionsCore';
import { BenefitChip, DetailRow, LiveFlash, SmallCrowdChip } from './CardParts';
import { CardPhoto } from './CardPhoto';
import { buildCardModel, formatClock, type AvailabilityLocal, type CardModel, type LiveDetail, type TFn } from './cardModel';
import { CongestionReportButton } from './CongestionReportButton';
import { DayForecast, GoldenHourLine } from './Extras';
import { loadHiddenPhotos } from './photoSafety';
import { hoursAnswerNotRecorded, type ReportLevel } from './reportCore';
import { localReportLevel } from './tripLoop';
import type { CompareAnchor, SheetCandidate } from './types';

/** 지금 걸린 여행 조건 칩(웹 CardCondition) — 홈이 만들어 넘긴다(G3-06). */
export interface CardCondition {
  key: 'walk' | 'indoor' | 'barrierFree' | 'stroller';
  /** 칩 글자(예: '🚶 도보 20분 이내'). */
  label: string;
  /** 해제 버튼 접근 이름에 넣을 조건 이름(이모지 없이). */
  name: string;
}

export interface RecommendationCardProps {
  /** 지금 보이는 장소. 없으면 status 에 따라 스켈레톤 · 오류 판, ready 면 아무것도 그리지 않는다. */
  selected: SheetCandidate | null;
  /** 보이는 추천 목록(순위 순) — 순위 배지 · 취향 비교 · '다음 후보'. */
  candidates: readonly SheetCandidate[];
  /** 이미 킵·거절해 다시 보이면 안 되는 장소 id. 이 카드가 처리한 것은 자동으로 더해진다. */
  excludedIds?: ReadonlySet<string>;
  /** loading = 첫 추천을 고르는 중(스켈레톤, G3-25) · error = 추천 실패(같은 자리의 오류 판, G3-26). */
  status?: 'ready' | 'loading' | 'error';
  onRetry?: () => void;
  /** 홈: 새 장소를 짧은 미리보기로 연다(웹 compactPeek). 저장 상세는 false — 바로 전체 카드. */
  compactPeek?: boolean;
  /** 비교 첫 줄(가치 상자 · 음식 문장)을 쓸지 — 홈 true, 저장 상세 false(G3-R02). */
  showCompare?: boolean;
  /** 순위 배지를 목록 순위로 — 홈 true, 저장 상세 false('AI 추천'). */
  showListRank?: boolean;
  /** 바로 갈래요(도보) 뒤 — 서버 수락 · 여정 기록 · 길안내는 카드가 이미 했다. */
  onAccept?: (c: SheetCandidate, mode: NavigationMode) => void;
  /** 주면 '자동차 길안내' 버튼을 그린다(저장 상세는 없음). 수락 부수효과 뒤에 부른다. */
  onDrive?: (c: SheetCandidate) => void;
  /** 다시 안볼래요 뒤 — next 가 다음에 보일 후보(오늘 휴무 확정 곳은 건너뛴다, G3-24). */
  onReject?: (c: SheetCandidate, next: SheetCandidate | null) => void;
  /** 주면 킵 버튼('일단 킵하고 다음 후보 볼래요')을 그린다. next 는 다음 후보(소진되면 맨 앞으로 되돈다). */
  onPutOff?: (c: SheetCandidate, next: SheetCandidate | null) => void;
  /** 직접 고른 장소의 '대신 갈 곳 보기'. 주면 userPicked 장소에서만 버튼이 열린다. */
  onSeeInstead?: (c: SheetCandidate) => void;
  /** 지금 걸린 여행 조건 칩 + ✕(G3-06). */
  conditions?: readonly CardCondition[];
  onRemoveCondition?: (key: CardCondition['key']) => void;
  /** 2·3번째 추천의 '추천 이유'(1위 대비) — 문장의 순위가 카드 순위와 같을 때만 홈이 넘긴다(G3-14). */
  comparisonReason?: string;
  /** 비교 헤더의 기준 명소('A 대신 B', G3-13). */
  compareAnchor?: CompareAnchor | null;
  /** ✨ 경주 테마 맥락 배지(G3-05 보완 — F2 가 넘긴다). */
  contextBadge?: string | null;
  travelContext?: TravelContext;
  /** '다시 안볼래요' 를 서버 거절·취향 학습 없이 — 저장 목록의 '목록에서 뺀다'. */
  rejectIsRemoval?: boolean;
  /** 카드 최대 높이(pt). 없으면 홈 기준(창 − 탭 막대 − NAV_GAP − 위 안전 영역 − 160, 웹 100dvh − clearance − 10rem). */
  maxHeight?: number;
  /** 미리보기 ↔ 펼친 카드가 바뀔 때(홈 예측 띠, G2-24). */
  onPeekChange?: (peek: boolean) => void;
  /** 웹 /main 의 알약 토스트(한 칸 · 3초)로 띄울 안내 — 홈이 HomeToast 를 넘긴다(G3-33). 없으면 앱 토스트. */
  onToast?: NotifyFn;
  onViewProfile?: () => void;
  onViewLab?: () => void;
}

const SPRING = { ...springs.sheet, reduceMotion: ReduceMotion.System };
/** 웹 shadow-sm(Tailwind v4). */
const SHADOW_SM = '0px 1px 3px rgba(0, 0, 0, 0.1), 0px 1px 2px -1px rgba(0, 0, 0, 0.1)';
/** 안드로이드는 흐림이 없어 흰 불투명 — 웹 빌드는 95% + backdrop-blur-2xl(40px). */
const CARD_BG = Platform.OS === 'android' ? '#ffffff' : 'rgba(255, 255, 255, 0.95)';
const WEB_BLUR = Platform.OS === 'web' ? ({ backdropFilter: 'blur(40px)' } as object) : null;
const GOLD_LINE = ['rgba(193, 154, 62, 0)', 'rgba(193, 154, 62, 0.5)', 'rgba(193, 154, 62, 0)'] as const;
const VALUE_BOX = ['rgba(193, 85, 59, 0.10)', 'rgba(193, 154, 62, 0.10)', 'rgba(62, 124, 106, 0.10)'] as const;
const FADE_TOP = ['rgba(255, 255, 255, 0.95)', 'rgba(255, 255, 255, 0)'] as const;
const FADE_BOTTOM = ['rgba(255, 255, 255, 0)', 'rgba(255, 255, 255, 0.95)'] as const;
/** 웹 '키 낮은 화면'(globals.css `short` = 높이 < 720) — 미리보기 가치 문장을 한 줄로. */
const SHORT_SCREEN = 720;
/** 끌기 시작(웹 SWIPE_GUARD_PX) · 옆으로 밀면 포기. */
const PAN_ACTIVE_Y = 12;
const PAN_FAIL_X = 24;

function useCountUp(target: number, key: string): number {
  // 웹 useCountUp(rollOnChange:false) — 새 장소일 때만 0 에서 굴러 올라가고, 같은 장소의 숫자 고침은 바로 반영한다.
  const reduce = useReduceMotion();
  const [value, setValue] = useState(target);
  const rolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!Number.isFinite(target)) return;
    if (reduce || rolledFor.current === key) {
      setValue(target);
      rolledFor.current = key;
      return;
    }
    rolledFor.current = key;
    const start = Date.now();
    const duration = 600;
    let frame = 0;
    const step = () => {
      const p = Math.min(1, (Date.now() - start) / duration);
      setValue(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) frame = requestAnimationFrame(step);
    };
    setValue(0);
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, key, reduce]);
  return value;
}

export function RecommendationCard(props: RecommendationCardProps) {
  const { selected, status = 'ready' } = props;
  const t = useT();
  if (!selected) {
    if (status === 'loading') return <CardSkeleton label={t('map.pickingFirst')} />;
    if (status === 'error') {
      return <ErrorState message={t('recommend.loadFailed')} onRetry={props.onRetry ?? (() => undefined)} retryLabel={t('common.retry')} />;
    }
    return null;
  }
  return <CardBody {...props} selected={selected} />;
}

/** 첫 추천을 고르는 동안 — 웹 /main 의 rec-skeleton(돌림표 + '지금 덜 붐비는 가까운 곳을 고르고 있어요…' + 막대 둘, G3-25). */
export function CardSkeleton({ label }: { label: string }) {
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLiveRegion="polite"
      accessibilityLabel={label}
      accessibilityState={{ busy: true }}
      style={{ borderRadius: 24, boxShadow: shadows.surface }}
    >
      <View style={[{ borderRadius: 24, borderWidth: 1, borderColor: colors.line, backgroundColor: CARD_BG, padding: 20 }, WEB_BLUR]}>
        <View className="mb-[12px] h-[6px] w-[64px] self-center rounded-full bg-muk/15" />
        <View className="flex-row items-center gap-[8px]">
          <RingSpinner size={14} borderWidth={2} trackColor="rgba(193,154,62,0.3)" headColor="gold-deep" />
          <Text className="min-w-0 flex-1 text-[13px] leading-[19.5px]" weight="extrabold">{label}</Text>
        </View>
        <View className="mt-[12px] gap-[8px]">
          <Skeleton height={24} width="80%" radius={8} />
          <Skeleton height={12} width="60%" radius={9999} />
        </View>
      </View>
    </View>
  );
}

type CardBodyProps = RecommendationCardProps & { selected: SheetCandidate };

function CardBody(props: CardBodyProps) {
  const { selected: c, candidates, compactPeek = true, showCompare = true, showListRank = true } = props;
  const { t, locale } = useI18n();
  const busyAt = useBusyThreshold();
  const reduceMotion = useReduceMotion();
  const insets = useSafeAreaInsets();
  const nav = useNavInsets();
  const { height: windowHeight } = useWindowDimensions();
  const f = c.facility;
  const id = String(f.id);
  const maxHeight = props.maxHeight ?? Math.max(240, windowHeight - nav.barHeight - nav.gap - insets.top - 160);

  // ── 높이 상태(웹 isMinimized · isExpanded) ───────────────────────────────────────────
  const [isMinimized, setIsMinimized] = useState(compactPeek);
  const [isExpanded, setIsExpanded] = useState(false);
  const [whyOpen, setWhyOpen] = useState(false);
  const [spotOpen, setSpotOpen] = useState(false);
  // 새 장소는 홈이면 미리보기로 연다 — 효과가 아니라 렌더 중 조정(이전 모습이 한 프레임도 그려지지 않게, 웹과 같다).
  const resetKey = `${id}|${compactPeek ? 'peek' : 'full'}`;
  const [lastResetKey, setLastResetKey] = useState(resetKey);
  if (lastResetKey !== resetKey) {
    setLastResetKey(resetKey);
    setIsMinimized(compactPeek);
    setIsExpanded(false);
    setWhyOpen(false);
    setSpotOpen(false);
  }
  const sheetState: SheetState = isMinimized ? 'minimized' : isExpanded ? 'expanded' : 'normal';
  const peekShown = compactPeek && isMinimized;
  const onPeekChangeRef = useRef(props.onPeekChange);
  onPeekChangeRef.current = props.onPeekChange;
  useEffect(() => {
    onPeekChangeRef.current?.(peekShown);
  }, [peekShown]);

  // ── 장소별 로컬 상태 ─────────────────────────────────────────────────────────────────
  const [now, setNow] = useState<Date | null>(null);
  const [confirmed, setConfirmed] = useState<'saved' | 'accepted' | null>(null);
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
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const rank = useMemo(() => {
    if (c.userPicked) return null;
    const i = candidates.findIndex((x) => String(x.facility.id) === id);
    return i < 0 ? null : i + 1;
  }, [c.userPicked, candidates, id]);
  // 익명 이용 기록 — 새 장소가 뜰 때 한 건.
  useEffect(() => {
    trackEvent('rec_shown', usageCardProps(f, rank));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // 다른 장소로 바뀌면 이전 장소의 로컬 상태를 비우고 맨 위부터(웹 title 효과).
  useEffect(() => {
    scrollRef.current?.scrollTo({ y: 0, animated: false });
    setConfirmed(null);
    setLocalReport(null);
    setHoursPrompt(false);
    setHoursError(false);
    setLocalAvailability(null);
    setLocalHours(null);
    setLiveDetail(null);
    setLiveLoading(false);
    setLiveAt(null);
    setFlash([]);
    setCooldown(false);
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }, [id]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const tastePeers = useMemo(
    () => candidates.map((x) => (typeof x.breakdown?.preference === 'number' ? Math.round(x.breakdown.preference * 100) : null)),
    [candidates],
  );
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
        showCompare,
        showListRank,
      }),
    [c, t, now, busyAt, rank, tastePeers, props.compareAnchor, localReport, localAvailability, localHours, liveDetail, hidden, locale, showCompare, showListRank],
  );
  const spotCount = useCountUp(model.hasSpot ? model.spotScore : Number.NaN, id);
  const prefCount = useCountUp(model.preferencePercent ?? Number.NaN, id);

  // ── 스크롤 영역 재기(가장자리 흐림 · 펼친 상세로 스크롤 · 반짝인 줄로 스크롤) ─────────────────
  const scrollY = useRef(0);
  const viewportH = useRef(0);
  const contentH = useRef(0);
  const [edges, setEdges] = useState({ up: false, down: false });
  const updateEdges = useCallback(() => {
    const up = scrollY.current > 2;
    const down = scrollY.current + viewportH.current < contentH.current - 2;
    setEdges((prev) => (prev.up === up && prev.down === down ? prev : { up, down }));
  }, []);
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollY.current = e.nativeEvent.contentOffset.y;
    updateEdges();
  };
  const layoutY = useRef<Record<string, { y: number; h: number }>>({});
  const scrollToY = (y: number) => scrollRef.current?.scrollTo({ y: Math.max(0, y), animated: !reduceMotion });
  // 손으로 상세를 열었으면 이름 막대가 처음 놓인 뒤 그 자리로 스크롤한다(80ms 타이머보다 늦게 재질 수 있다).
  const revealDetailsRef = useRef(false);
  const measure = (key: string) => (e: LayoutChangeEvent) => {
    layoutY.current[key] = { y: e.nativeEvent.layout.y, h: e.nativeEvent.layout.height };
    if (key === 'nameBar' && revealDetailsRef.current) {
      revealDetailsRef.current = false;
      // sticky 자식은 ScrollView 가 한 겹 더 감싸 y 가 0 으로 올 수 있다 — 바로 위 '상세 정보 접기' 버튼 아래(간격 8)로 잰다.
      later(() => {
        const toggle = layoutY.current.detailsToggle;
        if (toggle) scrollToY(toggle.y + toggle.h);
      }, 80);
    }
  };
  const later = (fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms));
  };

  // 손으로 상세를 열면 80ms 뒤 상세 머리(이름 막대)로 스크롤한다(웹 toggleExpand · I31).
  const toggleExpand = () => {
    const next = !isExpanded;
    setIsExpanded(next);
    revealDetailsRef.current = next;
    if (!next) delete layoutY.current.nameBar;
  };
  // 새로 연 상자(SPOT 설명 · 추천 근거)가 아래에 열려 보이지 않으면 끌어온다(웹 revealInScroller).
  const revealSpotInfo = () =>
    later(() => {
      const box = layoutY.current.spotInfo;
      if (!box) return;
      const bottom = box.y + box.h;
      if (bottom > scrollY.current + viewportH.current) scrollToY(bottom - viewportH.current + 8);
    }, 60);
  const revealWhy = () =>
    later(() => {
      const body = layoutY.current.details;
      const why = layoutY.current.whyBox;
      if (body && why) scrollToY(body.y + why.y - 8);
    }, 60);
  // 실시간 새로고침이 상세를 열면 새로 받은 첫 줄을 이름 막대 아래로 끌어온다(웹 revealRefreshedRow — 120·450ms 두 번).
  const revealRefreshedRow = (fields: LiveField[]) => {
    const order: [LiveField, string][] = [['hours', 'rowHours'], ['overview', 'rowOverview'], ['phone', 'rowContact'], ['homepage', 'rowHomepage']];
    const align = () => {
      const body = layoutY.current.details;
      const bar = layoutY.current.nameBar;
      const hit = order.find(([field, key]) => fields.includes(field) && layoutY.current[key]);
      if (!body || !hit) return;
      const row = layoutY.current[hit[1]];
      scrollToY(body.y + row.y - (bar?.h ?? 0) - 8);
    };
    later(align, 120);
    later(align, 450);
  };

  // 영업 확인 질문은 스크롤 영역 끝(바닥 버튼 바로 위)에 열린다 — 화면 안으로 끌어오고, 카카오맵에서 돌아오면 한 번 더(G3-19).
  useEffect(() => {
    if (!hoursPrompt || isMinimized) return;
    const timer = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: !reduceMotion }), 60);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') scrollRef.current?.scrollToEnd({ animated: !reduceMotion });
    });
    return () => {
      clearTimeout(timer);
      sub.remove();
    };
  }, [hoursPrompt, isMinimized, reduceMotion]);

  // 안드로이드 뒤로 — 홈이 보이는 동안 전체·상세면 미리보기로 접는다(웹에는 대응이 없다, §3 D13).
  useFocusEffect(
    useCallback(() => {
      if (!compactPeek || isMinimized) return undefined;
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        setIsExpanded(false);
        setIsMinimized(true);
        return true;
      });
      return () => sub.remove();
    }, [compactPeek, isMinimized]),
  );

  // ── 끌기 — 한 번에 한 칸(@/lib/sheetSnap), 끄는 동안 탄성, 놓으면 제자리로 ─────────────────────────
  const dragY = useSharedValue(0);
  const elasticTop = useSharedValue(sheetElastic(sheetState).top);
  const elasticBottom = useSharedValue(sheetElastic(sheetState).bottom);
  useEffect(() => {
    const e = sheetElastic(sheetState);
    elasticTop.value = e.top;
    elasticBottom.value = e.bottom;
  }, [sheetState, elasticTop, elasticBottom]);
  const stateRef = useRef(sheetState);
  stateRef.current = sheetState;
  const settle = useCallback((offset: number, velocity: number) => {
    const current = stateRef.current;
    const next = nextSheetState(current, offset, velocity);
    if (next === current) return;
    if (current === 'expanded') setIsExpanded(false);
    else if (current === 'minimized') {
      setIsMinimized(false);
      setIsExpanded(false);
    } else if (next === 'minimized') setIsMinimized(true);
    else setIsExpanded(true);
    haptic('selection');
  }, []);
  const makePan = () =>
    Gesture.Pan()
      .activeOffsetY([-PAN_ACTIVE_Y, PAN_ACTIVE_Y])
      .failOffsetX([-PAN_FAIL_X, PAN_FAIL_X])
      .onUpdate((e) => {
        dragY.value = e.translationY * (e.translationY < 0 ? elasticTop.value : elasticBottom.value);
      })
      .onEnd((e) => {
        runOnJS(settle)(e.translationY, e.velocityY);
        dragY.value = withSpring(0, SPRING);
      })
      .onFinalize(() => {
        if (dragY.value !== 0) dragY.value = withSpring(0, SPRING);
      });

  // 등장 — opacity 0 · y 18 · scale 0.985 → 시트 스프링(웹 initial). 새 장소마다.
  const enter = useSharedValue(reduceMotion ? 1 : 0);
  useEffect(() => {
    if (reduceMotion) {
      enter.value = 1;
      return;
    }
    enter.value = 0;
    enter.value = withSpring(1, SPRING);
  }, [id, reduceMotion, enter]);
  const frameStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, enter.value),
    transform: [{ translateY: (1 - enter.value) * 18 + dragY.value }, { scale: 0.985 + 0.015 * enter.value }],
  }));

  // ── 행동 ─────────────────────────────────────────────────────────────────────────────
  const notify = props.onToast;
  const excludedNow = () => new Set<string>([...(props.excludedIds ?? []), ...handled.current]);
  const doAccept = (mode: NavigationMode) => {
    setConfirmed('accepted');
    acceptCandidate(c, { mode, travelContext: props.travelContext, t, onViewProfile: props.onViewProfile, notify });
    if (mode === 'car') props.onDrive?.(c);
    else props.onAccept?.(c, mode);
  };
  const doReject = () => {
    haptic('selection');
    trackEvent('rec_next', usageCardProps(f, rank));
    handled.current.add(id);
    // 거절은 오늘 휴무 확정 곳을 건너뛴다(웹 handleReject openToday, G3-24).
    const next = nextCandidateAfter(candidates, f.id, excludedNow(), { skipClosedToday: true });
    if (!props.rejectIsRemoval) rejectCandidate(c, { t, hasNext: next !== null, onViewLab: props.onViewLab, notify });
    props.onReject?.(c, next);
  };
  const doKeep = () => {
    haptic('confirm');
    trackEvent('rec_later', usageCardProps(f, rank));
    setConfirmed('saved');
    handled.current.add(id);
    keepCandidate(c, t, busyAt, notify);
    props.onPutOff?.(c, nextAfterKeep(candidates, f.id, excludedNow()));
  };
  // '바로 갈래요' — 미리보기와 전체 카드가 같은 함수. 영업시간을 모르는 음식점·카페면 카카오맵 영업시간을 먼저 열고 묻는다.
  const onAcceptPress = () => {
    haptic('success');
    trackEvent('rec_accept', usageCardProps(f, rank));
    if (model.needsHoursConfirmation && model.kakaoPlaceUrl) {
      setHoursPrompt(true);
      setHoursError(false);
      if (compactPeek && isMinimized) setIsMinimized(false);
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
  const answerHours = async (answer: 'open' | 'closed') => {
    if (hoursBusy) return;
    const finish = () => {
      setHoursPrompt(false);
      haptic('success');
      if (answer === 'closed') doReject();
      else doAccept('walk');
    };
    setHoursBusy(true);
    setHoursError(false);
    try {
      setLocalAvailability(await reportFacilityAvailability(f.id, answer));
      finish();
    } catch (err) {
      if (hoursAnswerNotRecorded(err)) {
        // 게스트(403)·같은 네트워크의 다른 계정이 이미 알린 곳(429) — 판단은 잇되 '확인' 칩은 만들지 않는다.
        setLocalHours(answer);
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
        const fields = refreshedFields(next as never);
        setLiveDetail(next);
        setLiveAt(new Date());
        setFlash(fields);
        setCooldown(true);
        // 웹처럼 상세를 펼치고 새로 받은 첫 줄로 데려간다(G3-09).
        setIsExpanded(true);
        revealRefreshedRow(fields);
        toast.success(t('card.liveRefreshedToast'));
        timers.current.push(setTimeout(() => setFlash([]), LIVE_FLASH_MS), setTimeout(() => setCooldown(false), LIVE_REFRESH_COOLDOWN_MS));
      }
    } catch {
      /* 무해 폴백 — 캐시된 값을 그대로 둔다(에러 알림 없음) */
    } finally {
      setLiveLoading(false);
    }
  };

  const showInstead = !!props.onSeeInstead && !!c.userPicked;
  const onInstead = () => {
    haptic('selection');
    props.onSeeInstead?.(c);
  };
  const seeInsteadAria = t('card.seeInsteadAria', { name: model.title });
  const openFromPeek = () => setIsMinimized(false);
  const onHandlePress = () => {
    if (isMinimized) setIsMinimized(false);
    else {
      setIsExpanded(false);
      setIsMinimized(true);
    }
  };
  const reportFacility = useMemo(() => ({ id: f.id, name: f.name }), [f.id, f.name]);
  const onReported = useCallback(
    (level: ReportLevel) => setLocalReport({ level: localReportLevel(level), timestamp: new Date().toISOString() }),
    [],
  );

  // ── 그리기 ───────────────────────────────────────────────────────────────────────────
  const conditions = props.conditions ?? [];
  const conditionChips = conditions.length > 0 ? (
    <View className="flex-row flex-wrap items-center gap-[4px]">
      {conditions.map((cond) => (
        <Pressable
          key={cond.key}
          accessibilityRole="button"
          accessibilityLabel={t('condition.removeAria', { label: cond.name })}
          onPress={() => props.onRemoveCondition?.(cond.key)}
          hitSlop={8}
          className="h-[28px] flex-row items-center gap-[4px] rounded-full border border-jade/40 bg-white/85 px-[10px]"
        >
          <Text className="text-[12px] leading-[16px] text-jade" weight="bold">{cond.label}</Text>
          <Icon icon={X} size={12} color="jade" />
        </Pressable>
      ))}
    </View>
  ) : null;

  const handle = compactPeek ? (
    // 휴대폰 미리보기: 손잡이가 곧 '펼치기/미리보기로 접기' 버튼(웹 :1291-1312) — 막대 + 11px 금 글자, 가운데.
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t(isMinimized ? 'card.peek.expand' : 'card.peek.collapse')}
      accessibilityState={{ expanded: !isMinimized }}
      onPress={onHandlePress}
      hitSlop={{ top: 10, bottom: 10 }}
      noFeedback
      className="-mt-[4px] min-h-[24px] items-center justify-center gap-[2px] self-stretch rounded-full"
    >
      <View className="h-[6px] w-[64px] rounded-full bg-muk/20" />
      <Text className="text-[11px] leading-[16px] text-gold-deep" weight="bold" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {t(isMinimized ? 'card.peek.expand' : 'card.peek.collapse')}
      </Text>
    </Pressable>
  ) : (
    // 저장 상세: 글자 없는 장식 막대(읽기 숨김) — 누르면 미리보기 → 전체 → 상세(웹 :1316-1324).
    <Pressable
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      onPress={() => (isMinimized ? setIsMinimized(false) : toggleExpand())}
      hitSlop={{ top: 12, bottom: 12, left: 24, right: 24 }}
      noFeedback
      className="h-[6px] w-[64px] self-center rounded-full bg-muk/15"
    />
  );

  const arrivalText = model.showArrivalLine && now && model.times.arrival
    ? t('card.arrivalLine', { depart: formatClock(now), arrive: formatClock(model.times.arrival) })
    : null;
  const FaceMenuIcon = model.type === 'cafe' ? Coffee : Utensils;
  const menuLabel = model.faceMenu
    ? `${model.faceMenu.kind === 'menu' ? `${t('card.signatureMenu')} ` : ''}${model.faceMenu.items.join(' · ')}`
    : '';

  let body: ReactNode;
  if (isMinimized && compactPeek) {
    body = (
      <GestureDetector gesture={makePan()}>
        <View className="gap-[6px] px-[4px] pb-[2px]" collapsable={false}>
          {model.peekValueShown && (
            <Pressable accessibilityRole="button" accessibilityLabel={model.peekValueText} onPress={openFromPeek} noFeedback>
              <Text
                className="text-[14px] leading-[19.25px]"
                weight="extrabold"
                numberOfLines={model.foodHeadline ? undefined : windowHeight < SHORT_SCREEN ? 1 : 2}
              >
                {model.peekValueText}
              </Text>
            </Pressable>
          )}
          <View className="gap-[8px]">
            <Pressable accessibilityRole="button" accessibilityLabel={t('card.peek.expand')} onPress={openFromPeek} noFeedback>
              <View className="flex-row items-center gap-[6px]">
                <Text className="min-w-0 shrink font-serif text-[16px] leading-[20px]" style={{ letterSpacing: -0.4 }} weight="bold" numberOfLines={1} ellipsizeMode="tail">
                  {model.title}
                </Text>
                {model.hasSpot && (
                  <View className="shrink-0 rounded-md border border-gold/40 bg-gold/10 px-[6px] py-[2px]">
                    <Text className="text-[11px] leading-[15px] text-gold-deep" weight="extrabold" numberOfLines={1}>
                      {t('card.peek.spot', { n: model.spotScore })}
                    </Text>
                  </View>
                )}
                <Icon icon={ChevronUp} size={14} color="gold-deep" />
              </View>
              <View className="mt-[6px] flex-row flex-wrap items-center gap-[6px]">
                {arrivalText && (
                  <View className="flex-row items-center gap-[4px] rounded-md border border-jade/30 bg-jade/15 px-[8px] py-[2px]">
                    <Icon icon={Clock} size={12} color="jade" />
                    <Text className="text-[11px] leading-[15px] text-jade" weight="extrabold" numberOfLines={1}>{arrivalText}</Text>
                  </View>
                )}
                {!model.peekValueShown ? (
                  <PeekJadeChip>{t('card.peek.walk', { n: model.times.walkMin })}</PeekJadeChip>
                ) : model.compareHeaderText && model.displayedOpenStatus === 'open_expected' ? (
                  <PeekJadeChip>{t('compare.benefitOpen')}</PeekJadeChip>
                ) : null}
                {model.crowdChipOnFace && model.crowdChip && (
                  <SmallCrowdChip grade={model.crowdChip.grade} dashed={model.crowdChip.dashed}>{model.crowdChip.text}</SmallCrowdChip>
                )}
                {model.closedToday && (
                  <View className="rounded-md border border-terracotta/30 bg-terracotta/10 px-[8px] py-[2px]">
                    <Text className="text-[11px] leading-[15px] text-terracotta" weight="bold">{t('card.closedToday')}</Text>
                  </View>
                )}
                {model.faceMenu && (
                  // 미리보기는 '대표 메뉴' 이름표를 보이지 않게(읽기 이름에만) — 그림 + 음식 이름 전폭.
                  <View
                    accessible
                    accessibilityLabel={menuLabel}
                    className="min-h-[24px] w-full flex-row items-start gap-[4px] rounded-lg border border-gold/35 bg-gold/10 px-[8px] py-[4px]"
                  >
                    <Icon icon={FaceMenuIcon} size={14} color="gold-deep" />
                    <Text className="min-w-0 flex-1 text-[12px] leading-[16px]" weight="bold">{model.faceMenu.items.join(' · ')}</Text>
                  </View>
                )}
              </View>
            </Pressable>
            <View className="flex-row gap-[8px]">
              <AcceptButton label={t('card.accept')} aria={t('card.acceptAria')} confirmed={confirmed === 'accepted'} onPress={onAcceptPress} peek />
              {showInstead ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={seeInsteadAria}
                  onPress={onInstead}
                  className="min-h-[44px] min-w-0 flex-1 items-center justify-center rounded-2xl border border-jade/40 bg-jade/10 px-[8px] py-[8px]"
                >
                  <Text className="text-center text-[12px] leading-[15px] text-jade" weight="bold">{t('waiting.seeInstead')}</Text>
                </Pressable>
              ) : (
                <SoftButton label={t('card.reject')} aria={t('card.rejectAria')} onPress={doReject} peek />
              )}
            </View>
          </View>
        </View>
      </GestureDetector>
    );
  } else if (isMinimized) {
    // 저장 상세를 끌어 내린 한 줄 판 — 이름 + '열기 ▲'(웹 :1432-1441).
    body = (
      <GestureDetector gesture={makePan()}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${model.title}. ${t('card.open')}`}
          onPress={() => setIsMinimized(false)}
          noFeedback
          className="flex-row items-center justify-between px-[8px] pb-[4px]"
        >
          <Text className="max-w-[200px] text-[14px] leading-[20px]" weight="bold" numberOfLines={1}>{model.title}</Text>
          <View className="flex-row items-center gap-[2px] rounded-full border border-gold/25 bg-gold/10 px-[8px] py-[2px]">
            <Text className="text-[10px] leading-[15px] text-terracotta" weight="bold">{t('card.open')}</Text>
            <Icon icon={ChevronUp} size={12} color="terracotta" />
          </View>
        </Pressable>
      </GestureDetector>
    );
  } else {
    body = (
      <FullBody
        t={t}
        model={model}
        locale={locale}
        showCompare={showCompare}
        arrivalText={arrivalText}
        conditionChips={conditionChips}
        contextBadge={props.contextBadge ?? null}
        isExpanded={isExpanded}
        whyOpen={whyOpen}
        spotOpen={spotOpen}
        spotCount={spotCount}
        prefCount={prefCount}
        rank={rank}
        comparisonReason={props.comparisonReason}
        now={now}
        flash={flash}
        liveLoading={liveLoading}
        cooldown={cooldown}
        liveAt={liveAt}
        hoursPrompt={hoursPrompt}
        hoursBusy={hoursBusy}
        hoursError={hoursError}
        showInstead={showInstead}
        seeInsteadAria={seeInsteadAria}
        edges={edges}
        scrollRef={scrollRef}
        onScroll={onScroll}
        onViewport={(h) => {
          viewportH.current = h;
          updateEdges();
        }}
        onContentSize={(h) => {
          contentH.current = h;
          updateEdges();
        }}
        measure={measure}
        onToggleExpand={toggleExpand}
        onToggleSpot={() => {
          const next = !spotOpen;
          setSpotOpen(next);
          if (next) revealSpotInfo();
        }}
        onToggleWhy={() => {
          const next = !whyOpen;
          setWhyOpen(next);
          if (next) revealWhy();
        }}
        onRefreshLive={() => void refreshLive()}
        onHidden={(url) => setHidden((h) => (h.includes(url) ? h : [...h, url]))}
        onInstead={onInstead}
        onAnswerHours={(a) => void answerHours(a)}
        onUnsureHours={() => {
          setHoursPrompt(false);
          setHoursError(false);
        }}
        bottom={
          <GestureDetector gesture={makePan()}>
            <View collapsable={false} className="shrink-0 gap-[8px]">
              <View className="flex-row gap-[8px] pt-[4px]">
                <SoftButton label={t('card.reject')} aria={t('card.rejectAria')} onPress={doReject} />
                {props.onPutOff && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('card.putOffAria')}
                    onPress={doKeep}
                    className="min-h-[44px] flex-1 flex-row items-center justify-center gap-[6px] rounded-2xl border border-line bg-hanji-deep py-[10px]"
                  >
                    <Icon icon={confirmed === 'saved' ? Check : Bookmark} size={14} color={confirmed === 'saved' ? 'jade' : 'muk-soft'} />
                    <Text className="shrink text-center text-[12px] leading-[15px] text-muk-soft" weight="bold">{t('card.putOff')}</Text>
                  </Pressable>
                )}
                <AcceptButton label={t('card.accept')} aria={t('card.acceptAria')} confirmed={confirmed === 'accepted'} onPress={onAcceptPress} />
              </View>
              <View className="flex-row items-center gap-[8px]">
                {model.needsHoursConfirmation && model.kakaoPlaceUrl ? (
                  <Text className={cn('min-w-0 flex-1 text-[11px] leading-[13.75px]', model.likelyClosedUnknown ? 'text-terracotta' : 'text-muk-soft')} weight="medium">
                    {t('card.checkHoursKakaoHint')}
                  </Text>
                ) : props.onDrive ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('card.drive')}
                    onPress={onDrivePress}
                    className="min-h-[44px] min-w-0 flex-1 items-center justify-center rounded-xl border border-line bg-white py-[8px]"
                  >
                    <Text className="text-center text-[12px] leading-[16px] text-muk-soft" weight="bold">{t('card.drive')}</Text>
                  </Pressable>
                ) : (
                  <View className="flex-1" />
                )}
                <CongestionReportButton facility={reportFacility} isFirst={model.displayCongestionSource === 'none'} onReported={onReported} />
              </View>
            </View>
          </GestureDetector>
        }
      />
    );
  }

  return (
    <Animated.View
      // 바깥: 그림자 · 둥글기 · 최대 높이 · 등장/끌기 움직임. 높이가 바뀔 때 네이티브는 시트 스프링으로 따라간다(웹 framer layout).
      layout={Platform.OS === 'web' ? undefined : LinearTransition.springify().stiffness(380).damping(32).mass(0.82).reduceMotion(ReduceMotion.System)}
      style={[{ maxHeight, borderRadius: 24, boxShadow: shadows.surface }, frameStyle]}
      accessibilityLabel={model.title}
    >
      <View
        style={[
          {
            flexShrink: 1,
            borderRadius: 24,
            overflow: 'hidden',
            borderWidth: 1,
            borderColor: colors.line,
            backgroundColor: CARD_BG,
          },
          WEB_BLUR,
        ]}
      >
        {/* 위 2px 금 장식선(웹 via-gold/50). */}
        <Gradient colors={GOLD_LINE} style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2 }} pointerEvents="none" />
        <View
          style={{
            flexShrink: 1,
            gap: isMinimized ? 4 : 8,
            ...(isMinimized ? { padding: 12 } : { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 }),
          }}
        >
          <GestureDetector gesture={makePan()}>
            <View collapsable={false} className="self-stretch">{handle}</View>
          </GestureDetector>
          {body}
        </View>
      </View>
    </Animated.View>
  );
}

function PeekJadeChip({ children }: { children: string }) {
  return (
    <View className="rounded-md border border-jade/30 bg-jade/10 px-[8px] py-[2px]">
      <Text className="text-[11px] leading-[15px] text-jade" weight="bold" numberOfLines={1}>{children}</Text>
    </View>
  );
}

/** 바로 갈래요 — 금 진 → 주칠 그라데이션 + 흰 12px 굵게 + 주 버튼 그림자(웹 cta-primary · shadow-[0_4px_14px…]). */
function AcceptButton({ label, aria, confirmed, onPress, peek = false }: { label: string; aria: string; confirmed: boolean; onPress: () => void; peek?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={aria}
      onPress={onPress}
      className={cn('min-h-[44px] min-w-0 flex-1 flex-row items-center justify-center gap-[6px] rounded-2xl', peek ? 'px-[12px] py-[8px]' : 'px-[8px] py-[10px]')}
      style={{ boxShadow: shadows.cta }}
    >
      <Gradient name="cta" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 16 }} pointerEvents="none" />
      {confirmed && (
        <View>
          <Icon icon={Check} size={14} color="white" />
        </View>
      )}
      <Text className="shrink text-center text-[12px] leading-[15px] text-white" weight="bold">{label}</Text>
    </Pressable>
  );
}

/** 다시 안볼래요 — 한지 진 바탕 · line 테두리 · 먹 연 12px(웹 :2258-2264). */
function SoftButton({ label, aria, onPress, peek = false }: { label: string; aria: string; onPress: () => void; peek?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={aria}
      onPress={onPress}
      className={cn('min-h-[44px] min-w-0 flex-1 items-center justify-center rounded-2xl border border-line bg-hanji-deep px-[8px]', peek ? 'py-[8px]' : 'py-[10px]')}
    >
      <Text className="text-center text-[12px] leading-[15px] text-muk-soft" weight="bold">{label}</Text>
    </Pressable>
  );
}

type FullBodyProps = {
  t: TFn;
  model: CardModel;
  locale: string;
  showCompare: boolean;
  arrivalText: string | null;
  conditionChips: ReactNode;
  contextBadge: string | null;
  isExpanded: boolean;
  whyOpen: boolean;
  spotOpen: boolean;
  spotCount: number;
  prefCount: number;
  rank: number | null;
  comparisonReason?: string;
  now: Date | null;
  flash: LiveField[];
  liveLoading: boolean;
  cooldown: boolean;
  liveAt: Date | null;
  hoursPrompt: boolean;
  hoursBusy: boolean;
  hoursError: boolean;
  showInstead: boolean;
  seeInsteadAria: string;
  edges: { up: boolean; down: boolean };
  scrollRef: React.RefObject<ScrollView | null>;
  onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onViewport: (h: number) => void;
  onContentSize: (h: number) => void;
  measure: (key: string) => (e: LayoutChangeEvent) => void;
  onToggleExpand: () => void;
  onToggleSpot: () => void;
  onToggleWhy: () => void;
  onRefreshLive: () => void;
  onHidden: (url: string) => void;
  onInstead: () => void;
  onAnswerHours: (a: 'open' | 'closed') => void;
  onUnsureHours: () => void;
  bottom: ReactNode;
};

/** 전체 카드 — 스크롤 영역(웹 순서 1~11) + 바닥 고정 버튼 두 줄(G3-07). */
function FullBody(p: FullBodyProps) {
  const { t, model } = p;
  const FaceMenuIcon = model.type === 'cafe' ? Coffee : Utensils;
  // 요리 분류(cuisine)는 카카오 한국어 태그 — ko 가 아니면 칩을 그리지 않는다(cardModel 의 cuisineInForeignLocale 과 같은 이유).
  const showFaceMenu = !!model.faceMenu && (model.faceMenu.kind !== 'cuisine' || p.locale === 'ko');
  const spotReasonOnFace = !!p.comparisonReason && typeof p.rank === 'number' && p.rank >= 2;

  // ScrollView 의 직계 자식 — 이름 막대를 sticky 로 붙이려면 그 자리(인덱스)를 알아야 한다(stickyHeaderIndices).
  const items: { key: string; node: ReactNode }[] = [];
  const push = (key: string, node: ReactNode) => {
    if (node) items.push({ key, node });
  };

  // 1. 가치 상자 — showCompare 일 때만(저장 상세는 조건 칩만, G3-05 · G3-R02).
  if (p.showCompare) {
    push(
      'value',
      <View className="overflow-hidden rounded-2xl border border-terracotta/25 px-[12px] py-[8px]">
        <Gradient colors={VALUE_BOX} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} pointerEvents="none" />
        <View className="flex-row flex-wrap items-center gap-x-[8px] gap-y-[4px]">
          <Text className="pt-[2px] text-[12px] leading-[18px] text-terracotta" weight="bold">{model.compareKicker}</Text>
          {p.arrivalText && (
            <View className="flex-row items-center gap-[6px] rounded-full bg-jade/15 px-[10px] py-[2px]">
              <Icon icon={Clock} size={14} color="jade" />
              <Text className="text-[13px] leading-[19.5px] text-jade" weight="extrabold" numberOfLines={1}>{p.arrivalText}</Text>
            </View>
          )}
        </View>
        {model.foodHeadline || model.compareHeaderText ? (
          <Text className="mt-[2px] text-[16px] leading-[22px]" weight="extrabold" accessibilityRole="header">
            {model.foodHeadline ?? model.compareHeaderText}
          </Text>
        ) : (
          // 혜택형 — '{이름} · [도보 N분] · 도착 시 영업 · 취향 N%'. 둥근 도보 칸은 Text 안에 못 넣어 한 줄 묶음으로 나눠 그린다.
          <View className="mt-[2px] flex-row flex-wrap items-center" accessible accessibilityRole="header" accessibilityLabel={[model.title, ...model.benefitParts].join(' · ')}>
            <Text className="text-[16px] leading-[22px]" weight="extrabold">{`${model.title} · `}</Text>
            <View className="rounded-full bg-jade/15 px-[8px]">
              <Text className="text-[16px] leading-[22px] text-jade" weight="extrabold">{model.benefitParts[0]}</Text>
            </View>
            {model.benefitParts.length > 1 && (
              <Text className="text-[16px] leading-[22px]" weight="extrabold">{` · ${model.benefitParts.slice(1).join(' · ')}`}</Text>
            )}
          </View>
        )}
        {(p.contextBadge || p.conditionChips) && (
          <View className="mt-[6px] flex-row flex-wrap items-center gap-[4px]">
            {p.contextBadge && (
              <View className="rounded-full border border-jade/40 bg-jade/10 px-[8px] py-[2px]">
                <Text className="text-[11px] leading-[16.5px] text-jade" weight="bold">{`✨ ${p.contextBadge}`}</Text>
              </View>
            )}
            {p.conditionChips}
          </View>
        )}
      </View>,
    );
  } else if (p.conditionChips) {
    push('conditions', p.conditionChips);
  }

  // 2. 사진 띠 — 저장 상세는 사진이 있을 때만(사진 없는 저장 장소에 표지를 끼우지 않는다, G3-R02).
  if (p.showCompare || model.photoUrls.length > 0) {
    push('photo', <CardPhoto model={model} facilityName={model.title} onHidden={p.onHidden} height={112} />);
  }

  // 3. 실시간 정보 새로고침(G3-09).
  if (model.canLiveRefresh) {
    push(
      'live',
      <View className="flex-row flex-wrap items-center gap-x-[8px] gap-y-[4px]">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('card.liveRefresh')}
          accessibilityState={{ disabled: p.liveLoading || p.cooldown, busy: p.liveLoading }}
          disabled={p.liveLoading || p.cooldown}
          onPress={p.onRefreshLive}
          hitSlop={4}
          className={cn('h-[36px] shrink-0 flex-row items-center gap-[6px] rounded-full border border-gold/60 bg-white px-[14px]', p.liveLoading || p.cooldown ? 'opacity-60' : '')}
        >
          <SpinIcon spinning={p.liveLoading} />
          <Text className="text-[13px] leading-[18px] text-gold-deep" weight="bold">{t('card.liveRefresh')}</Text>
        </Pressable>
        <Text className="text-[12px] leading-[18px] text-muk-soft" weight="semibold">{t('card.liveCredit')}</Text>
        {p.liveAt && (
          <View className="rounded-full bg-jade/15 px-[10px] py-[2px]" accessibilityLiveRegion="polite">
            <Text className="text-[12px] leading-[18px] text-jade" weight="bold">{`✓ ${t('card.liveRefreshed', { time: formatClock(p.liveAt) })}`}</Text>
          </View>
        )}
      </View>,
    );
  }

  // 4. 순위 배지 · 근거 칩 · 메뉴 · 이름 + SPOT 상자(G3-10). 왼쪽 묶음을 누르면 상세를 연다.
  push(
    'name',
    <View className="flex-row items-start justify-between gap-[12px]">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={model.title}
        accessibilityHint={t(p.isExpanded ? 'card.detailsCollapse' : 'card.detailsExpand')}
        accessibilityState={{ expanded: p.isExpanded }}
        onPress={p.onToggleExpand}
        noFeedback
        className="min-w-0 flex-1"
      >
        <View className="mb-[4px] flex-row flex-wrap items-center gap-[6px]">
          <View
            className={cn('flex-row items-center gap-[4px] overflow-hidden rounded-lg px-[10px] py-[4px]', model.rankIsListed ? '' : 'bg-gold/15')}
            style={model.rankIsListed ? { boxShadow: SHADOW_SM } : undefined}
          >
            {model.rankIsListed && (
              <Gradient name="cta" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} pointerEvents="none" />
            )}
            {/* 웹 빌드: 절대 배치 그라데이션이 위치 없는 svg 위에 칠해지므로 아이콘을 View(relative)로 감싼다. */}
            <View>
              <Icon icon={Sparkles} size={12} color={model.rankIsListed ? 'white' : 'gold-deep'} />
            </View>
            <Text className={cn('text-[11px] leading-[16.5px]', model.rankIsListed ? 'text-white' : 'text-gold-deep')} weight="black">
              {t(model.rankText.key, model.rankText.vars)}
            </Text>
          </View>
          {model.chipArrivalAction && (
            <View
              className={cn(
                'rounded-md border px-[8px] py-[2px]',
                model.chipArrivalAction === 'choose_calmer' ? 'border-jade/30 bg-jade/10' : 'border-sky-500-web/25 bg-sky-500-web/10',
              )}
            >
              <Text
                className={cn('text-[11px] leading-[16.5px]', model.chipArrivalAction === 'choose_calmer' ? 'text-jade' : 'text-sky-700-web')}
                weight="bold"
                numberOfLines={1}
              >
                {t(model.chipArrivalAction === 'choose_calmer' ? 'recommend.alternativeBasis.crowd' : 'recommend.alternativeBasis.timing')}
              </Text>
            </View>
          )}
          {showFaceMenu && model.faceMenu && (
            <View
              accessible
              accessibilityLabel={`${model.faceMenu.kind === 'menu' ? `${t('card.signatureMenu')} ` : ''}${model.faceMenu.items.join(' · ')}`}
              className="min-h-[24px] w-full flex-row items-start gap-[4px] rounded-lg border border-gold/35 bg-gold/10 px-[8px] py-[4px]"
            >
              <Icon icon={FaceMenuIcon} size={14} color="gold-deep" />
              <Text className="min-w-0 flex-1 text-[13px] leading-[16px]" weight="bold">{model.faceMenu.items.join(' · ')}</Text>
            </View>
          )}
        </View>
        <Text className="font-serif text-[20px] leading-[25px]" style={{ letterSpacing: -0.5 }} weight="bold" accessibilityRole="header">
          {model.title}
        </Text>
      </Pressable>
      {model.hasSpot && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${t('card.peek.spot', { n: model.spotScore })}. ${t('card.spotTooltipAria')}`}
          accessibilityState={{ expanded: p.spotOpen }}
          onPress={p.onToggleSpot}
          className={cn(
            'min-h-[60px] min-w-[60px] shrink-0 items-center justify-center gap-[4px] overflow-hidden rounded-2xl border px-[8px] py-[6px]',
            p.spotOpen ? 'border-gold bg-gold/20' : 'border-gold/40',
          )}
          style={{ boxShadow: SHADOW_SM }}
        >
          {!p.spotOpen && (
            <Gradient
              colors={['rgba(193, 154, 62, 0.2)', 'rgba(193, 154, 62, 0.05)']}
              start={{ x: 0.5, y: 0 }}
              end={{ x: 0.5, y: 1 }}
              style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
              pointerEvents="none"
            />
          )}
          <Text className="text-[12px] leading-[12px] text-gold-deep" weight="bold" numberOfLines={1}>{`${t('card.spotScoreLabel')} ⓘ`}</Text>
          <Text className="text-[22px] leading-[22px]" weight="black">
            {p.spotCount}
            <Text className="text-[11px] text-muk-soft" weight="regular">{` ${t('card.pointSuffix')}`}</Text>
          </Text>
        </Pressable>
      )}
    </View>,
  );

  // 5. SPOT 설명 — 이름 블록 바로 아래.
  if (model.hasSpot && p.spotOpen) {
    push(
      'spotInfo',
      <View className="rounded-2xl border border-gold/35 bg-gold/10 px-[14px] py-[12px]">
        <Text className="text-[13px] leading-[19.5px] text-gold-deep" weight="extrabold">{t('card.spotTooltipTitle')}</Text>
        <Text className="mt-[4px] text-[12px] leading-[19.5px]">{t('card.spotInfoIntro')}</Text>
        <Text className="mt-[8px] text-[11px] leading-[16.5px] text-muk-soft" weight="bold">{t('card.spotInfoPlace')}</Text>
        <View className="mt-[4px] gap-[2px]">
          {model.preferencePercent !== null && (
            <Text className="text-[12px] leading-[18px]" weight="semibold">{`· ${t('card.spotInfoTaste', { pct: model.preferencePercent })}`}</Text>
          )}
          <Text className="text-[12px] leading-[18px]" weight="semibold">
            {`· ${model.times.waitMin !== null
              ? t('card.spotInfoTimeWait', { walk: model.times.walkMin, wait: model.times.waitMin })
              : t('card.spotInfoTime', { walk: model.times.walkMin })}`}
          </Text>
          {model.perkText && <Text className="text-[12px] leading-[18px]" weight="semibold">{`· ${t('card.spotInfoPerk', { perk: model.perkText })}`}</Text>}
        </View>
      </View>,
    );
  }

  // 6. 혜택 칩 + (저장 상세) 출발 → 도착 글자.
  const arrivalInChips = !p.showCompare && p.arrivalText;
  if (model.faceChips.length > 0 || arrivalInChips) {
    push(
      'chips',
      <View className="flex-row flex-wrap items-center gap-x-[10px] gap-y-[6px]">
        {model.faceChips.map((chip) => (
          <BenefitChip key={chip.key} tone={chip.tone} dashed={chip.dashed}>{chip.text}</BenefitChip>
        ))}
        {arrivalInChips && (
          <View className="flex-row items-center gap-[6px]">
            <Icon icon={Clock} size={14} color="jade" />
            <Text className="text-[13px] leading-[19.5px]" weight="semibold" numberOfLines={1}>{p.arrivalText}</Text>
          </View>
        )}
      </View>,
    );
  }
  if (model.likelyClosedUnknown && model.times.arrival) {
    push(
      'likelyClosed',
      <Text className="text-[12px] leading-[19.5px] text-terracotta" weight="medium">
        {t('card.likelyClosedReason', { time: formatClock(model.times.arrival) })}
      </Text>,
    );
  }

  // 7. 직접 고른 곳 — '대신 갈 곳 보기' 전폭.
  if (p.showInstead) {
    push(
      'instead',
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={p.seeInsteadAria}
        onPress={p.onInstead}
        className="min-h-[44px] w-full flex-row items-center justify-center gap-[4px] rounded-2xl border border-jade/40 bg-jade/10 px-[12px] py-[8px]"
      >
        <Text className="text-[13px] leading-[19.5px] text-jade" weight="bold">{t('waiting.seeInstead')}</Text>
        <Icon icon={ChevronRight} size={15} color="jade" />
      </Pressable>,
    );
  }

  // 8. 2·3위 '추천 이유'(G3-14).
  if (spotReasonOnFace) {
    push(
      'reason',
      <View className="rounded-xl border border-jade/20 bg-jade/5 px-[12px] py-[8px]">
        <Text className="text-[11px] leading-[16.5px] text-jade" weight="extrabold">{t('recommend.spotComparison.current')}</Text>
        <Text className="mt-[2px] text-[12px] leading-[16.5px]" weight="semibold">{p.comparisonReason}</Text>
      </View>,
    );
  }

  // 9. 상세 정보 펼치기/접기 — 상세에 닿는 키보드·스크린리더 경로(G3-15).
  const detailsLabel = t(p.isExpanded ? 'card.detailsCollapse' : 'card.detailsExpand');
  push(
    'detailsToggle',
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={detailsLabel}
      accessibilityState={{ expanded: p.isExpanded }}
      onPress={p.onToggleExpand}
      hitSlop={{ top: 2, bottom: 2 }}
      className="min-h-[40px] w-full flex-row items-center justify-center gap-[6px] rounded-2xl border border-gold/40 bg-gold/5 px-[12px] py-[8px]"
    >
      <Icon icon={p.isExpanded ? ChevronUp : ChevronDown} size={15} color="gold-deep" />
      <Text className="text-[13px] leading-[19.5px] text-gold-deep" weight="bold">{detailsLabel}</Text>
    </Pressable>,
  );

  // 10. 펼친 상세 — 이름 막대(sticky) + 본문(G3-16 · 17 · 18).
  let stickyIndex = -1;
  if (p.isExpanded) {
    stickyIndex = items.length;
    push(
      'nameBar',
      <View className="flex-row items-center gap-[8px] border-b border-line bg-white/95 px-[4px] py-[6px]">
        <Icon icon={MapPin} size={13} color="gold-deep" />
        <Text className="min-w-0 flex-1 text-[13px] leading-[19.5px]" weight="extrabold" numberOfLines={1}>{model.title}</Text>
      </View>,
    );
    push('details', <Details {...p} />);
  }

  // 11. 영업 확인 질문(G3-19) — 스크롤 영역 끝.
  if (p.hoursPrompt) {
    push(
      'hours',
      <HoursPrompt busy={p.hoursBusy} error={p.hoursError} onAnswer={p.onAnswerHours} onUnsure={p.onUnsureHours} />,
    );
  }

  return (
    <>
      <View style={{ flexShrink: 1, minHeight: 0 }}>
        <ScrollView
          ref={p.scrollRef}
          style={{ flexGrow: 0, flexShrink: 1 }}
          contentContainerStyle={{ gap: 8, paddingBottom: 4 }}
          stickyHeaderIndices={stickyIndex >= 0 ? [stickyIndex] : undefined}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled
          onScroll={p.onScroll}
          scrollEventThrottle={32}
          onLayout={(e) => p.onViewport(e.nativeEvent.layout.height)}
          onContentSizeChange={(_w, h) => p.onContentSize(h)}
        >
          {items.map((it) =>
            // 직계 자식마다 자리를 잰다(스크롤 내용 기준 y — 펼친 상세 · SPOT 설명 · 반짝인 줄로 스크롤할 때).
            Platform.OS === 'web' ? (
              <View key={it.key} onLayout={p.measure(it.key)}>{it.node}</View>
            ) : (
              // 미리보기 → 전체로 열 때 내용 160ms 페이드(웹 .sheet-content-in). 웹 빌드는 entering 이 안 돌아 생략.
              <Animated.View key={it.key} onLayout={p.measure(it.key)} entering={FadeIn.duration(160).reduceMotion(ReduceMotion.System)}>
                {it.node}
              </Animated.View>
            ),
          )}
        </ScrollView>
        {/* 가장자리 흐림 — 위·아래로 더 볼 내용이 있을 때만(웹 .rec-fade-top 20 · .rec-fade-bottom 24). */}
        {p.edges.up && <Gradient colors={FADE_TOP} pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 20 }} />}
        {p.edges.down && <Gradient colors={FADE_BOTTOM} pointerEvents="none" style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 24 }} />}
      </View>
      {p.bottom}
    </>
  );
}

function SpinIcon({ spinning }: { spinning: boolean }) {
  const reduce = useReduceMotion();
  const turn = useSharedValue(0);
  useEffect(() => {
    if (spinning && !reduce) {
      turn.value = 0;
      turn.value = withRepeat(withTiming(1, { duration: 1000, easing: Easing.linear }), -1, false);
    } else {
      cancelAnimation(turn);
      turn.value = 0;
    }
  }, [spinning, reduce, turn]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value * 360}deg` }] }));
  return (
    <Animated.View style={style}>
      <Icon icon={RefreshCw} size={15} color="gold-deep" />
    </Animated.View>
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
  const t = useT();
  // 웹 :2222-2249 — 질문 12px · 안내 11px · 버튼 3칸(보이는 높이 약 31, 누르는 자리는 hitSlop 으로 44).
  const cell = 'flex-1 items-center justify-center rounded-xl px-[8px] py-[8px]';
  return (
    <View accessibilityRole="none" accessibilityLabel={t('card.hoursCheckQuestion')} className="rounded-2xl border border-gold/30 bg-gold/10 p-[12px]">
      <Text className="text-[12px] leading-[16px]" weight="extrabold">{t('card.hoursCheckQuestion')}</Text>
      <Text className="mt-[4px] text-[11px] leading-[17.875px] text-muk-soft">{t('card.hoursCheckPrivacy')}</Text>
      <View className="mt-[12px] flex-row gap-[8px]">
        <Pressable accessibilityRole="button" disabled={busy} accessibilityLabel={t('card.hoursOpen')} onPress={() => onAnswer('open')} hitSlop={7} className={cn(cell, 'bg-jade', busy ? 'opacity-50' : '')}>
          <Text className="text-center text-[11px] leading-[15px] text-white" weight="bold">{t('card.hoursOpen')}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" disabled={busy} accessibilityLabel={t('card.hoursClosed')} onPress={() => onAnswer('closed')} hitSlop={7} className={cn(cell, 'bg-terracotta', busy ? 'opacity-50' : '')}>
          <Text className="text-center text-[11px] leading-[15px] text-white" weight="bold">{t('card.hoursClosed')}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" disabled={busy} accessibilityLabel={t('card.hoursUnsure')} onPress={onUnsure} hitSlop={7} className={cn(cell, 'border border-line bg-white', busy ? 'opacity-50' : '')}>
          <Text className="text-center text-[11px] leading-[15px] text-muk-soft" weight="bold">{t('card.hoursUnsure')}</Text>
        </Pressable>
      </View>
      {error && (
        <Text className="mt-[8px] text-[10px] leading-[15px] text-terracotta" weight="semibold" accessibilityLiveRegion="polite">
          {t('card.hoursReportFailed')}
        </Text>
      )}
    </View>
  );
}

/** 상세 본문 — 웹 :1752-2220(space-y-3 pt-3 text-xs). 줄마다 onLayout 으로 자리를 재 둔다(반짝인 줄로 스크롤). */
function Details(p: FullBodyProps) {
  const { t, model, flash } = p;
  const lines = model.openHourLines;
  const has = (field: LiveField) => flash.includes(field);
  return (
    <View className="gap-[12px] pt-[4px]">
      {model.menuTokens.length > 0 && (
        <DetailRow icon={Utensils} label={t('card.signatureMenu')}>
          <View className="mt-[4px] flex-row flex-wrap gap-[4px]">
            {model.menuTokens.map((m) => (
              <View key={m} className="rounded-full bg-gold/10 px-[8px] py-[2px]">
                <Text className="text-[11px] leading-[16.5px]" weight="semibold">{m}</Text>
              </View>
            ))}
          </View>
        </DetailRow>
      )}

      {(lines.length > 0 || model.closedDayLines.length > 0) && (
        <View onLayout={p.measure('rowHours')} className="flex-row gap-[12px]">
          {lines.length > 0 && (
            <View className="min-w-0 flex-1">
              <DetailRow icon={Clock} label={t('card.hours')} flash={has('hours')}>
                {lines.map((line, i) => (
                  <Text key={`${i}-${line}`} className="text-[12px] leading-[16px]">
                    {line}
                    {i === lines.length - 1 && model.hoursExtra.close ? ` ~ ${model.hoursExtra.close}` : ''}
                    {i === lines.length - 1 && model.hoursExtra.weekday ? ` (${model.hoursExtra.weekday})` : ''}
                  </Text>
                ))}
              </DetailRow>
            </View>
          )}
          {model.closedDayLines.length > 0 && (
            <View className="min-w-0 flex-1">
              <DetailRow icon={Clock} label={t('card.closedDays')} flash={has('hours')}>
                {model.closedDayLines.map((line, i) => (
                  <Text key={`${i}-${line}`} className="text-[12px] leading-[16px]">{line}</Text>
                ))}
              </DetailRow>
            </View>
          )}
        </View>
      )}

      {model.overview && (
        <View onLayout={p.measure('rowOverview')}>
          <LiveFlash flash={has('overview')}>
            <Text className="mb-[2px] text-[10px] leading-[15px] text-muk-soft" weight="bold">{t('card.about')}</Text>
            <Text className="text-[12px] leading-[19.5px]" numberOfLines={6}>{model.overview}</Text>
          </LiveFlash>
        </View>
      )}

      {(model.address || model.phone) && (
        <View onLayout={p.measure('rowContact')} className="flex-row gap-[12px]">
          {model.address && (
            <View className="min-w-0 flex-1">
              <DetailRow icon={MapPin} label={t('card.address')}>
                <Text className="text-[12px] leading-[19.5px]">{model.address}</Text>
              </DetailRow>
            </View>
          )}
          {model.phone && (
            <View className="min-w-0 flex-1">
              <DetailRow icon={Phone} label={t('card.phone')} flash={has('phone')}>
                {model.phoneHref ? (
                  <Pressable accessibilityRole="link" accessibilityLabel={model.phone} onPress={() => void openPhone(model.phone)} hitSlop={14} noFeedback className="self-start">
                    <Text className="text-[12px] leading-[16px] text-gold-deep underline" style={{ letterSpacing: -0.3 }} weight="bold">{model.phone}</Text>
                  </Pressable>
                ) : (
                  <Text className="text-[12px] leading-[16px]">{model.phone}</Text>
                )}
              </DetailRow>
            </View>
          )}
        </View>
      )}

      {model.homepageUrl && (
        <View onLayout={p.measure('rowHomepage')}>
          <DetailRow icon={Globe} label={t(model.homepageIsExternalChannel ? 'card.externalChannel' : 'card.website')} flash={has('homepage')}>
            <Pressable accessibilityRole="link" accessibilityLabel={model.homepageHost ?? model.homepageUrl} onPress={() => void openExternalUrl(model.homepageUrl as string)} hitSlop={14} noFeedback className="self-start">
              <Text className="text-[12px] leading-[16px] text-gold-deep underline" style={{ letterSpacing: -0.3 }} weight="bold">{model.homepageHost}</Text>
            </Pressable>
          </DetailRow>
        </View>
      )}

      {model.reviewUrl && (
        // 카카오 장소 페이지 — '상세 리뷰 보기 ↗'(오른쪽, 웹 placeInfo.url).
        <View className="flex-row justify-end">
          <Pressable accessibilityRole="link" accessibilityLabel={t('card.viewReviews')} onPress={() => void openExternalUrl(model.reviewUrl as string)} hitSlop={14} noFeedback>
            <Text className="text-[12px] leading-[16px] text-gold-deep underline" style={{ letterSpacing: -0.3 }} weight="extrabold">{t('card.viewReviews')}</Text>
          </Pressable>
        </View>
      )}

      <Text className="rounded-2xl border border-gold/25 bg-gold/10 px-[14px] py-[10px] text-[13px] leading-[21.125px]">{`💡 ${model.reason}`}</Text>

      {model.hasSpot && (
        <View onLayout={p.measure('whyBox')} className="rounded-2xl border border-line">
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: p.whyOpen }}
            accessibilityLabel={t('card.whyToggle')}
            onPress={p.onToggleWhy}
            hitSlop={{ top: 4, bottom: 4 }}
            noFeedback
            className="flex-row items-center justify-between gap-[8px] rounded-2xl px-[12px] py-[10px]"
          >
            <Text className="text-[12px] leading-[16px]" weight="bold">{t('card.whyToggle')}</Text>
            <Icon icon={p.whyOpen ? ChevronUp : ChevronDown} size={14} />
          </Pressable>
          {p.whyOpen && <WhyPanel {...p} />}
        </View>
      )}
    </View>
  );
}

/** '추천 근거 자세히' — 웹 :1904-2213(1위 이유 · 시간/취향 타일 · 타임라인 · 근거 칩 · 주변 수요 · 축제 · 골든타임 · 오늘 예측). */
function WhyPanel(p: FullBodyProps) {
  const { t, model } = p;
  const { times } = model;
  const a = model.area;
  const spotReasonOnFace = !!p.comparisonReason && typeof p.rank === 'number' && p.rank >= 2;
  const hasEvidence = (model.crowdChip && !model.crowdChipOnFace) || model.freshnessStamp || model.remaining || model.availabilityLine;
  return (
    <View className="gap-[12px] border-t border-line px-[12px] pb-[12px] pt-[12px]">
      {p.comparisonReason && !spotReasonOnFace && (
        <View className="rounded-xl border border-jade/20 bg-jade/5 px-[12px] py-[8px]">
          <Text className="text-[10px] leading-[15px] text-jade" weight="extrabold">{t('recommend.spotComparison.current')}</Text>
          <Text className="mt-[2px] text-[11px] leading-[15.125px]" weight="semibold">{p.comparisonReason}</Text>
        </View>
      )}

      <View className="flex-row gap-[8px]">
        <View className="min-w-0 flex-1 justify-center overflow-hidden rounded-2xl border border-gold/20 p-[12px]">
          <Gradient
            colors={['rgba(193, 154, 62, 0.10)', 'rgba(193, 154, 62, 0.05)']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
            pointerEvents="none"
          />
          <View className="absolute right-0 top-0 p-[8px] opacity-20" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Icon icon={Clock} size={24} color="gold" />
          </View>
          <Text className="mb-[4px] text-[10px] leading-[15px] text-muk-soft" weight="semibold">{t(times.waitMin !== null ? 'card.totalTime' : 'card.walkTime')}</Text>
          <View className="mb-[6px] flex-row items-baseline gap-[4px]">
            <Text className="text-[24px] leading-[32px]" weight="black">{times.totalMin}</Text>
            <Text className="text-[12px] leading-[16px] text-muk-soft" weight="medium">{t('card.minute')}</Text>
          </View>
          {times.waitMin !== null && (
            <View className="flex-row flex-wrap items-center gap-[8px]">
              <View className="rounded bg-gold/15 px-[6px] py-[2px]">
                <Text className="text-[10px] leading-[15px] text-gold-deep" weight="medium">{t('card.wait', { n: times.waitMin })}</Text>
              </View>
              <Text className="text-[10px] leading-[15px] text-muk-soft/60">+</Text>
              <View className="rounded bg-jade/15 px-[6px] py-[2px]">
                <Text className="text-[10px] leading-[15px] text-jade" weight="medium">{t('card.travel', { n: times.walkMin })}</Text>
              </View>
            </View>
          )}
          {model.travelSource && (
            <Text className="mt-[4px] text-[11px] leading-[16.5px] text-muk-soft" weight="semibold">
              {t(model.travelSource === 'osm_pedestrian' ? 'card.travelRoute' : 'card.travelEstimate')}
            </Text>
          )}
        </View>
        <View className="w-[110px] items-center justify-center rounded-2xl border border-line bg-hanji-deep p-[12px]">
          <Text className="mb-[4px] text-center text-[10px] leading-[15px] text-muk-soft" weight="semibold">{t('card.prefMatch')}</Text>
          <View className="mb-[4px] flex-row items-baseline gap-[2px]">
            <Text className="text-[20px] leading-[28px] text-jade" weight="black">{model.preferencePercent !== null ? p.prefCount : '–'}</Text>
            <Text className="text-[12px] leading-[16px] text-jade/80" weight="bold">%</Text>
          </View>
          <Text className="mt-[2px] text-center text-[10px] leading-[15px] text-muk-soft" numberOfLines={2}>{t('card.prefBasis')}</Text>
        </View>
      </View>

      {p.now && times.arrival && <Timeline t={t} now={p.now} times={times} type={model.type} />}

      {hasEvidence && (
        <View className="flex-row flex-wrap items-center gap-[6px]">
          {model.crowdChip && !model.crowdChipOnFace && (
            <SmallCrowdChip grade={model.crowdChip.grade} dashed={model.crowdChip.dashed}>{model.crowdChip.text}</SmallCrowdChip>
          )}
          {model.freshnessStamp && (
            <View className="rounded-md border border-dashed border-line px-[8px] py-[2px]">
              <Text className="text-[10px] leading-[15px] text-muk-soft" weight="medium">{model.freshnessStamp}</Text>
            </View>
          )}
          {model.remaining && (
            <View className="rounded-md border border-line bg-hanji-deep px-[8px] py-[2px]">
              <Text className="text-[10px] leading-[15px] text-muk-soft" weight="medium">
                {`${t('card.remainingLabel')}: ${t('card.remainingValue', model.remaining)}`}
              </Text>
            </View>
          )}
          {model.availabilityLine && (
            <View className={cn('rounded-md border px-[8px] py-[2px]', model.availabilityOpen ? 'border-jade/25 bg-jade/10' : 'border-terracotta/25 bg-terracotta/10')}>
              <Text className={cn('text-[10px] leading-[15px]', model.availabilityOpen ? 'text-jade' : 'text-terracotta')} weight="semibold">
                {model.availabilityLine}
              </Text>
            </View>
          )}
        </View>
      )}
      {model.licenseLine && <Text className="text-[10px] leading-[15px] text-muk-soft">{model.licenseLine}</Text>}

      {a && (
        // 주변 붐빔 근거 — 하늘색 상자(주차) · 남색 상자(관광), 웹 Tailwind v4 sky/indigo(G3-17).
        <View className="rounded-xl border border-sky-500-web/20 bg-sky-500-web/10 px-[12px] py-[8px]">
          <View className="flex-row items-center justify-between gap-[8px]">
            <Text className="min-w-0 flex-1 text-[11px] leading-[13.75px] text-sky-800-web" weight="bold">{a.title}</Text>
            {a.mode && <Text className="text-[10px] leading-[13.75px] text-sky-700-web">{a.mode}</Text>}
          </View>
          {a.action && <Text className="mt-[6px] text-[11px] leading-[13.75px] text-sky-900-web" weight="extrabold">{a.action}</Text>}
          {a.rank && <Text className="mt-[4px] text-[11px] leading-[13.75px] text-sky-800-web">{a.rank}</Text>}
          {a.delayed && <Text className="mt-[4px] text-[11px] leading-[13.75px] text-sky-800-web">{a.delayed}</Text>}
          {a.compositeHint && <Text className="mt-[4px] text-[11px] leading-[13.75px] text-sky-800-web/80">{t('recommend.areaDemandCompositeHint')}</Text>}
          {a.parking && (
            <View className="mt-[8px] rounded-lg border border-sky-500-web/20 bg-white/55 px-[10px] py-[8px]">
              <Text className="text-[11px] leading-[13.75px] text-sky-900-web" weight="bold">{a.parking.title}</Text>
              <Text className="mt-[2px] text-[10px] leading-[13.75px] text-sky-700-web">{a.parking.sub}</Text>
            </View>
          )}
          {a.tourism && (
            <View className="mt-[8px] rounded-lg border border-indigo-500-web/20 bg-white/55 px-[10px] py-[8px]">
              <Text className="text-[11px] leading-[13.75px] text-indigo-900-web" weight="bold">{a.tourism.title}</Text>
              <Text className="mt-[2px] text-[10px] leading-[13.75px] text-indigo-700-web">{a.tourism.sub}</Text>
              <Text className="mt-[4px] text-[10px] leading-[13.75px] text-indigo-700-web/90">{a.tourism.disclaimer}</Text>
            </View>
          )}
          {a.sources && <Text className="mt-[4px] text-[10px] leading-[13.75px] text-sky-700-web">{a.sources}</Text>}
          {a.confidence && <Text className="mt-[4px] text-[10px] leading-[13.75px] text-sky-700-web">{a.confidence}</Text>}
        </View>
      )}
      {model.eventLine && (
        <Text className="rounded-xl border border-terracotta/20 bg-terracotta/10 px-[12px] py-[8px] text-[11px] leading-[13.75px] text-terracotta">{model.eventLine}</Text>
      )}

      {/* 골든타임 · 오늘 예측 — 근거를 연 동안만 마운트(웹처럼 그때 부른다, G3-18). 예측은 상세가 열려 있을 때만. */}
      <GoldenHourLine facilityId={model.id} enabled />
      <DayForecast facilityType={model.type} enabled={p.isExpanded} />
    </View>
  );
}

/** 출발 → 도착(→ 식사·관람) 타임라인 — 웹 :1972-1999. 점 8px + 한지 진 4px 테두리(ring-4), 선 2px line. */
function Timeline({ t, now, times, type }: { t: TFn; now: Date; times: CardModel['times']; type: string }) {
  const service = times.service;
  const dot = (color: string) => (
    <View className="mb-[6px] h-[16px] w-[16px] items-center justify-center rounded-full bg-hanji-deep" style={{ margin: -4, marginBottom: 2 }}>
      <View className={cn('h-[8px] w-[8px] rounded-full', color)} />
    </View>
  );
  const stop = (time: Date, label: string, color: string) => (
    <View className="w-[48px] items-center">
      {dot(color)}
      <Text className="text-[10px] leading-[15px]" weight="bold">{formatClock(time)}</Text>
      <Text className="mt-[2px] text-[10px] leading-[15px] text-muk-soft">{label}</Text>
    </View>
  );
  const pill = (text: string, tone: 'jade' | 'gold') => (
    <View className={cn('rounded border bg-hanji-deep px-[6px] py-[2px]', tone === 'jade' ? 'border-jade/25' : 'border-gold/25')}>
      <Text className={cn('text-[10px] leading-[15px]', tone === 'jade' ? 'text-jade' : 'text-gold-deep')} weight="medium" numberOfLines={1}>{text}</Text>
    </View>
  );
  return (
    <View className="rounded-2xl border border-line bg-hanji-deep px-[16px] py-[12px]">
      <View className="mt-[4px] flex-row items-start justify-between">
        <View className="absolute left-[16px] right-[16px] top-[3px] h-[2px] bg-line" />
        {stop(now, t('card.depart'), 'bg-gold')}
        {times.arrival && stop(times.arrival, t('card.arrive'), 'bg-jade')}
        {service && stop(service, type === 'restaurant' || type === 'cafe' ? t('card.dine') : t('card.view'), 'bg-gold')}
        {/* 이동·대기 칩 — 구간 가운데(대기가 있으면 25% · 75%). */}
        <View className="absolute top-[-10px] items-center" style={service ? { left: 0, width: '50%' } : { left: 0, right: 0 }} pointerEvents="none">
          {pill(t('card.travel', { n: times.walkMin }), 'jade')}
        </View>
        {service && times.waitMin !== null && (
          <View className="absolute top-[-10px] items-center" style={{ right: 0, width: '50%' }} pointerEvents="none">
            {pill(t('card.wait', { n: times.waitMin }), 'gold')}
          </View>
        )}
      </View>
    </View>
  );
}
