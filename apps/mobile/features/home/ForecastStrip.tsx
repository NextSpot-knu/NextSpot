// 홈 '🔮 혼잡 예측' 띠(G2-24 · H2b) — 웹 apps/web/components/main/ForecastTimeStrip.tsx 의 휴대폰 모양(390px)을 옮겼다.
// 자리는 부모가 정한다(웹: 간결한 지도 스택의 첫 항목 — 카드 미리보기 바로 위, gap 8). 이 컴포넌트는 판 하나만 그리고 자료를 부르지 않는다
// — 값은 useForecastStrip(상태) · forecastStripModel(배지·범례) 이 만든다. 연결은 H3b.
//
// 휴대폰에서 보이는 것(웹 max-md 규칙 그대로):
//   · 판 16,449,358×46 — rounded-2xl · border-line · 흰 바탕 · px 8 · py 6 · 그림자 0 6 22 먹 .16.
//   · 한 줄: '🔮 혼잡 예측'(11 extrabold) 또는 예측을 받았으면 그 자리에 짧은 배지('🔮 여유 예측', 등급색) · 네 칸 트랙(225×27,
//     hanji-deep 알약, 고른 칸 먹 알약 + 한지 글자) · '다른 시간' 50×32(시계 14 + ▾ 14, 글자는 읽기 이름만).
//   · 긴 배지 줄은 휴대폰에서 숨긴다. 범례 줄은 예측 중(점선)일 때만, 키 낮은 화면(높이 720 미만)에서는 그때도 숨긴다.
//     '지금 이 일대 … · 추정' 칩(areaChip)은 휴대폰에서 그리지 않는다(웹 max-md:hidden) — 넓은 화면용 값이라 prop 만 받는다.
//   · 트랙: 누르기 · 끌기(끄는 동안 칸만 따라오고 뗄 때 한 번 고른다) · 접근성 adjustable(increment/decrement) · 웹 빌드 방향키.
//   · '다른 시간': 웹처럼 버튼 위 오른쪽에 붙는 메뉴(폭 176). 안드로이드는 부모 밖 터치가 막히므로 RN Modal 위에 단추 자리를 재서 그린다.
// 등장: 웹 .strip-enter(240ms 뒤 180ms 흐려졌다 나타남 — 카드가 접히는 동안 숨었다가 떠오른다). 동작 줄이기면 바로.
import { ChevronDown, Clock3 } from 'lucide-react-native';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  Modal,
  Platform,
  View,
  useWindowDimensions,
  type AccessibilityActionEvent,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { CongestionKey } from '@/lib/congestionScale';
import { PIN_GRADE_COLORS, RANK_BADGE } from '@/lib/map/markerSvg';
import { Icon } from '~/components/ui/Icon';
import { Pressable } from '~/components/ui/Pressable';
import { RingSpinner } from '~/components/ui/RingSpinner';
import { Text } from '~/components/ui/Text';
import { useReduceMotion } from '~/components/ui/useReduceMotion';
import { useT } from '~/lib/i18n/I18nProvider';
import { colors, shadows } from '~/lib/theme/tokens';

import {
  FORECAST_STOPS,
  stopAtX,
  stopForKey,
  type ForecastHours,
  type StripBadge,
  type StripLegend,
} from './forecastStripModel';

const GRADES: CongestionKey[] = ['quiet', 'relaxed', 'moderate', 'busy'];

/** 웹 BADGE_TONE(globals.css .benefit-quiet · .benefit-relaxed 포함) — [테두리·바탕, 글자]. 등급이 없으면 line/hanji-deep/muk. */
const BADGE_TONE: Record<CongestionKey | 'none', [string, string]> = {
  quiet: ['border-benefit-quiet/35 bg-benefit-quiet/10', 'text-benefit-quiet-ink'],
  relaxed: ['border-benefit-relaxed/35 bg-benefit-relaxed/10', 'text-benefit-relaxed-ink'],
  moderate: ['border-gold/45 bg-gold/15', 'text-gold-deep'],
  busy: ['border-terracotta/40 bg-terracotta/10', 'text-terracotta'],
  none: ['border-line bg-hanji-deep', 'text-muk'],
};

/** 웹 `short:` 변형(@media max-height 719.98px) — 키 낮은 휴대폰은 예측 중에도 범례 줄을 감춘다. */
const SHORT_SCREEN_MAX_HEIGHT = 720;
/** 웹 shadow-sm(v4): 0 1 3 0 / 0 1 2 −1 검정 .1. */
const THUMB_SHADOW = '0px 1px 3px 0px rgba(0, 0, 0, 0.1), 0px 1px 2px -1px rgba(0, 0, 0, 0.1)';
/** 메뉴 그림자 — 웹 shadow-[0_10px_30px_rgba(43,35,32,0.2)]. */
const MENU_SHADOW = '0px 10px 30px rgba(43, 35, 32, 0.2)';
/** 범례 점선 고리 — 웹 outline 1px dashed muk/40 · offset 1(자리를 차지하지 않는다 → 음수 여백). */
const DASH_COLOR = 'rgba(43, 35, 32, 0.4)';

export interface ForecastPreset {
  id: string;
  label: string;
}

export interface ForecastStripProps {
  /** 트랙에서 고른 칸(0 = 지금). 요일 프리셋이 걸려 있으면 트랙은 아무 칸도 칠하지 않는다. */
  hours: ForecastHours;
  /** 예측을 받는 중(고른 칸에 도는 표시). */
  loading: boolean;
  /** 걸린 요일 프리셋 id('now' 면 없음). */
  presetId: string;
  /** 요일 프리셋('지금' 제외) — STRIP_PRESETS 를 t(labelKey) 로. */
  presets: ForecastPreset[];
  onSelectHours: (hours: ForecastHours) => void;
  onSelectPreset: (id: string) => void;
  /** 예측 배지(stripBadgeFor). 휴대폰은 short 만 보이고 text 는 읽기 이름. */
  badge: StripBadge | null;
  /** 범례(stripLegendFor). 휴대폰은 dashed 일 때만. */
  legend: StripLegend | null;
  /** '지금 이 일대 … · 추정' — 휴대폰은 그리지 않는다(웹 max-md:hidden). */
  areaChip?: string | null;
  /** 소개 바로가기(?focus=forecast)로 왔을 때 판 고리 — 웹 ring-4 gold + offset 2 hanji. */
  ringed?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function ForecastStrip({
  hours,
  loading,
  presetId,
  presets,
  onSelectHours,
  onSelectPreset,
  badge,
  legend,
  ringed = false,
  style,
}: ForecastStripProps) {
  const t = useT();
  const reduceMotion = useReduceMotion();
  const { height: windowHeight } = useWindowDimensions();
  const [dragStop, setDragStop] = useState<ForecastHours | null>(null);
  const presetActive = presetId !== 'now';
  const activePreset = presets.find((p) => p.id === presetId) ?? null;
  const shown: ForecastHours | null = dragStop ?? (presetActive ? null : hours);
  const label = (h: number) => (h === 0 ? t('forecast.now') : t('forecast.ahead', { h }));
  // 휴대폰 칸(약 55px)은 짧은 이름 — 일·중은 '後/后' 를 뺀다(ko·en 은 같은 글).
  const shortLabel = (h: number) => (h === 0 ? t('forecast.now') : t('forecast.aheadShort', { h }));

  // 예측 배지 알림 — 웹 role=status 의 앱판. 네이티브는 바뀔 때 한 번 announceForAccessibility(안드로이드 live region 은 새로
  // 붙은 뷰를 읽지 않고, iOS 에는 live region 이 없다). 웹 빌드는 aria-live(아래 accessibilityLiveRegion)가 읽는다.
  const badgeText = badge?.text ?? null;
  const announcedRef = useRef<string | null>(badgeText);
  useEffect(() => {
    if (badgeText === announcedRef.current) return;
    announcedRef.current = badgeText;
    if (badgeText && Platform.OS !== 'web') AccessibilityInfo.announceForAccessibility(badgeText);
  }, [badgeText]);

  // 등장(웹 .strip-enter) — 마운트 때 한 번.
  const appear = useSharedValue(reduceMotion ? 1 : 0);
  useEffect(() => {
    if (reduceMotion) {
      appear.value = 1;
      return;
    }
    appear.value = withDelay(240, withTiming(1, { duration: 180 }));
    // 마운트 때만 — 동작 줄이기 바뀜은 다음 등장부터.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const appearStyle = useAnimatedStyle(() => ({ opacity: appear.value }));

  // ── 트랙 ──
  const [trackWidth, setTrackWidth] = useState(0);
  const widthRef = useRef(0);
  const leftRef = useRef(0); // 트랙 왼쪽 끝의 pageX(누를 때 pageX − locationX 로 잰다)
  const dragRef = useRef<ForecastHours | null>(null);
  const thumbPos = useSharedValue(shown ?? 0);
  const thumbWidth = useSharedValue(0);
  useEffect(() => {
    if (shown === null) return;
    thumbPos.value = reduceMotion ? shown : withTiming(shown, { duration: 150 });
  }, [shown, reduceMotion, thumbPos]);
  const thumbStyle = useAnimatedStyle(() => ({
    left: (thumbPos.value * thumbWidth.value) / 4 + 2,
    width: Math.max(0, thumbWidth.value / 4 - 4),
  }));
  const onTrackLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    widthRef.current = w;
    thumbWidth.value = w;
    setTrackWidth(w);
  };
  const stopFromEvent = (e: GestureResponderEvent): ForecastHours =>
    stopAtX(e.nativeEvent.pageX - leftRef.current, widthRef.current, hours);
  const setDrag = (next: ForecastHours | null) => {
    dragRef.current = next;
    setDragStop(next);
  };
  const responder = {
    onStartShouldSetResponder: () => true,
    onMoveShouldSetResponder: () => true,
    // 끄는 동안 지도·부모가 손가락을 빼앗지 않게(웹 setPointerCapture).
    onResponderTerminationRequest: () => false,
    onResponderGrant: (e: GestureResponderEvent) => {
      // 칸 글자는 눌림을 받지 않으므로(pointerEvents none) locationX 는 트랙 기준이다.
      leftRef.current = e.nativeEvent.pageX - e.nativeEvent.locationX;
      setDrag(stopFromEvent(e));
    },
    onResponderMove: (e: GestureResponderEvent) => {
      const next = stopFromEvent(e);
      if (next !== dragRef.current) setDrag(next);
    },
    onResponderRelease: (e: GestureResponderEvent) => {
      const next = stopFromEvent(e);
      setDrag(null);
      onSelectHours(next);
    },
    onResponderTerminate: () => setDrag(null),
  };
  const step = (key: string): boolean => {
    const next = stopForKey(key, hours, presetActive);
    if (next === null) return false;
    onSelectHours(next);
    return true;
  };
  const onAccessibilityAction = (e: AccessibilityActionEvent) => {
    step(e.nativeEvent.actionName);
  };
  // 웹 빌드만: 키보드 초점 + 방향키(웹 onKeyDown). 네이티브는 접근성 increment/decrement.
  const webKeyProps =
    Platform.OS === 'web'
      ? ({
          focusable: true,
          onKeyDown: (e: { key: string; preventDefault: () => void }) => {
            if (step(e.key)) e.preventDefault();
          },
        } as object)
      : {};

  // ── '다른 시간' 메뉴 ──
  const triggerRef = useRef<View>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; w: number } | null>(null);
  const [menuHeight, setMenuHeight] = useState(0);
  const { width: windowWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const openMenu = () => {
    const node = triggerRef.current;
    if (!node) return;
    node.measureInWindow((x, y, w) => {
      setMenuHeight(0);
      setMenu({ x, y, w });
    });
  };
  const closeMenu = () => setMenu(null);
  const triggerLabel = activePreset ? `${t('forecast.otherTimes')}: ${activePreset.label}` : t('forecast.otherTimes');
  const triggerTone = presetActive ? 'gold-deep' : 'muk-soft';

  const ring = ringed ? `0px 0px 0px 2px ${colors.hanji}, 0px 0px 0px 6px ${colors.gold}, ` : '';
  const badgeTone = BADGE_TONE[badge?.grade ?? 'none'];
  const showLegend = !!legend?.dashed && windowHeight >= SHORT_SCREEN_MAX_HEIGHT;

  return (
    // 바깥 Animated.View 는 등장 투명도만(Reanimated 컴포넌트에는 NativeWind className 이 붙지 않는다 — 판 모양은 안쪽 View).
    <Animated.View style={[{ width: '100%' }, appearStyle, style]}>
    <View
      testID="forecast-strip"
      role="region"
      accessibilityLabel={t('forecast.name')}
      className="w-full rounded-2xl border border-line bg-white px-[8px] py-[6px]"
      style={{ boxShadow: `${ring}${shadows.glass}` }}
    >
      <View className="flex-row items-center gap-[6px]">
        {badge ? (
          // 휴대폰: 배지 줄 대신 이 자리에 짧은 배지(등급색). 읽는 이름은 긴 배지 그대로.
          <View
            testID="forecast-badge-short"
            accessible
            accessibilityLabel={badge.text}
            accessibilityLiveRegion={Platform.OS === 'web' ? 'polite' : 'none'}
            className={`shrink-0 rounded-full border px-[6px] py-[2px] ${badgeTone[0]}`}
          >
            <Text className={`text-[11px] leading-[13.75px] ${badgeTone[1]}`} weight="extrabold" numberOfLines={1}>
              {badge.short}
            </Text>
          </View>
        ) : (
          <Text className="shrink-0 text-[11px] text-muk" weight="extrabold" numberOfLines={1}>
            {t('forecast.title')}
          </Text>
        )}
        <View
          testID="forecast-track"
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={t('forecast.name')}
          accessibilityValue={{
            min: 0,
            max: 3,
            now: presetActive ? 0 : hours,
            text: activePreset ? activePreset.label : label(hours),
          }}
          accessibilityState={{ busy: loading }}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={onAccessibilityAction}
          onLayout={onTrackLayout}
          // 트랙은 웹처럼 27 — 누르는 자리는 위아래 8 씩(판 안쪽 여백 안이라 지도 끌기와 겹치지 않는다).
          hitSlop={{ top: 8, bottom: 8 }}
          {...responder}
          {...webKeyProps}
          className="min-w-0 flex-1 flex-row rounded-full bg-hanji-deep p-[2px]"
        >
          {shown !== null && trackWidth > 0 ? (
            <Animated.View
              pointerEvents="none"
              style={[
                { position: 'absolute', top: 2, bottom: 2, borderRadius: 9999, backgroundColor: colors.muk, boxShadow: THUMB_SHADOW },
                thumbStyle,
              ]}
            />
          ) : null}
          {FORECAST_STOPS.map((h) => (
            <View
              key={h}
              pointerEvents="none"
              className="flex-1 flex-row items-center justify-center gap-[4px] px-[4px] py-[6px]"
            >
              {loading && shown === h && h > 0 ? (
                <RingSpinner size={10} borderWidth={1.5} trackColor="rgba(250, 245, 236, 0.4)" headColor="hanji" />
              ) : null}
              <Text
                className={`text-[11px] leading-[11px] ${shown === h ? 'text-hanji' : 'text-muk-soft'}`}
                weight="bold"
                numberOfLines={1}
              >
                {shortLabel(h)}
              </Text>
            </View>
          ))}
        </View>
        <Pressable
          ref={triggerRef}
          testID="forecast-other-times"
          accessibilityRole="button"
          accessibilityLabel={triggerLabel}
          accessibilityState={{ expanded: menu !== null }}
          hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
          onPress={openMenu}
          className={`h-[32px] shrink-0 flex-row items-center gap-[4px] rounded-full border px-[8px] ${
            presetActive ? 'border-gold bg-gold/15' : 'border-line bg-white'
          }`}
        >
          <Icon icon={Clock3} size={14} color={triggerTone} />
          <Icon icon={ChevronDown} size={14} color={triggerTone} />
        </Pressable>
      </View>
      {showLegend && legend ? (
        <View testID="forecast-legend" className="mt-[6px] flex-row flex-wrap items-center gap-x-[10px] gap-y-[4px] px-[4px]">
          <Text className="text-[11px] text-muk" weight="bold">
            {legend.title}
          </Text>
          {GRADES.map((grade) => (
            <View key={grade} className="flex-row items-center gap-[4px]">
              <DashedRing>
                <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: PIN_GRADE_COLORS[grade].base }} />
              </DashedRing>
              <Text className="text-[11px] text-muk-soft" weight="bold">
                {t(`congestion.${grade}`)}
              </Text>
            </View>
          ))}
          <View testID="forecast-legend-pick" className="flex-row items-center gap-[4px]">
            {/* 예측 중의 순위 핀은 번호 원 + 흰 점선 고리 — 범례도 그 모양(웹 rank-dashed). */}
            <DashedRing>
              <View
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 7,
                  backgroundColor: RANK_BADGE.fill,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text className="text-[8px] leading-[8px]" weight="black" style={{ color: RANK_BADGE.text }}>
                  1
                </Text>
              </View>
            </DashedRing>
            <Text className="text-[11px] text-muk-soft" weight="bold">
              {t('forecast.legendPick')}
            </Text>
          </View>
        </View>
      ) : null}

      <Modal visible={menu !== null} transparent animationType="none" onRequestClose={closeMenu} statusBarTranslucent>
        <Pressable
          noFeedback
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}
          onPress={closeMenu}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        />
        {menu ? (
          <View
            accessibilityViewIsModal
            onAccessibilityEscape={closeMenu}
            role="menu"
            accessibilityLabel={t('forecast.otherTimes')}
            onLayout={(e) => setMenuHeight(e.nativeEvent.layout.height)}
            className="absolute w-[176px] rounded-2xl border border-line bg-white p-[4px]"
            style={{
              // 웹 bottom-full right-0 mb-2 — 단추 위 8, 오른쪽 끝 맞춤. 높이를 재기 전에는 숨긴다.
              right: Math.max(8, windowWidth - (menu.x + menu.w)),
              // 위 안전 영역 아래로만(상태 표시줄 밑으로 들어가지 않게).
              top: Math.max(insets.top + 8, menu.y - 8 - menuHeight),
              opacity: menuHeight > 0 ? 1 : 0,
              boxShadow: MENU_SHADOW,
            }}
          >
            {presets.map((preset) => {
              const selected = preset.id === presetId;
              return (
                // 행은 최소 44(탭 영역 기준 — 웹 행은 36). 이웃 행과 붙어 있어 hitSlop 으로는 넓히지 않는다.
                <Pressable
                  key={preset.id}
                  accessibilityRole="menuitem"
                  accessibilityState={{ checked: selected }}
                  onPress={() => {
                    closeMenu();
                    onSelectPreset(preset.id);
                  }}
                  className={`min-h-[44px] flex-row items-center justify-between rounded-xl px-[12px] py-[8px] ${selected ? 'bg-gold/15' : ''}`}
                >
                  <Text className={`text-[13px] ${selected ? 'text-gold-deep' : 'text-muk'}`} weight="bold">
                    {preset.label}
                  </Text>
                  {selected ? (
                    <Text accessibilityElementsHidden importantForAccessibility="no" className="text-[13px] text-gold-deep" weight="bold">
                      ✓
                    </Text>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        ) : null}
      </Modal>
    </View>
    </Animated.View>
  );
}

/** 웹 `outline outline-1 outline-dashed outline-offset-1 outline-muk/40` — 자리를 차지하지 않는 점선 고리. */
function DashedRing({ children }: { children: ReactNode }) {
  return (
    <View
      style={{
        margin: -2,
        padding: 1,
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor: DASH_COLOR,
        borderRadius: 9999,
      }}
    >
      {children}
    </View>
  );
}
