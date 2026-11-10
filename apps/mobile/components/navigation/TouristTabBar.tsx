// 관광객 하단 탭 막대 — 웹 apps/web/components/shell/BottomNav.tsx 의 폰 막대(:154-214)(G2-G01·G2-R02, docs/MOBILE_WEB_PARITY.md §4.2 F11).
//
// · 자리: 탭 내비게이터의 기본 자리(보통 흐름 — 화면 위에 겹치지 않는다, §4.3). 높이 = NAV_BAR_HEIGHT(101) + 아래 안전 영역.
//   웹은 막대가 겹치고 내용에 clearance(116) 여백을 주므로, 탭 화면은 navMetrics 의 NAV_GAP(15)만 남긴다.
// · 모양: 흰 90% + 위 테두리 + 그림자. 유리·흐림은 쓰지 않는다(D14 — 아래가 한지라 사실상 흰색, 유리 글자색 바꿈도 피한다).
// · 안내 줄(32): 왼쪽 '서비스 소개'(openGuide), 오른쪽 콘솔 입구 둘(D7 ① — 운영 웹을 외부 브라우저로).
// · 탭 줄(48): 다섯 칸, 활성 알약 56×48 이 스프링으로 미끄러진다(동작 줄이기면 바로 옮김).
// · 누름: 그 탭 자리에서 다시 누르면 아무 일 없음(햅틱도 없음, 웹 :69 · D13(d) — 마이 하위의 '마이'도). 숨은 경로의 '홈'은 홈으로 간다.
//   아니면 tabPress emit → 막히지 않았으면 햅틱 → 이동. 마이는 중첩 Stack 첫 화면까지 되돌린다(pop).
// · 키보드가 떠 있는 동안은 숨긴다(네이티브만 — tabBarHideOnKeyboard 와 같은 이벤트). 폰 웹도 고정 막대가 키보드에 가려진다.
// · 숨은 경로(explore/recommend · explore/map)는 그리지 않고, 활성은 경로로 정한다(explore → 홈, mypage 하위 → 마이).
import type { BottomTabBarProps } from 'expo-router/js-tabs';
import {
  Bookmark,
  CircleHelp,
  Home,
  Landmark,
  Route,
  Store,
  Timer,
  User,
  type LucideIcon,
} from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { Keyboard, Platform, View, type LayoutChangeEvent } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

import { Icon } from '~/components/ui/Icon';
import { Pressable } from '~/components/ui/Pressable';
import { Text } from '~/components/ui/Text';
import { useReduceMotion } from '~/components/ui/useReduceMotion';
import { openGuide } from '~/features/onboarding/guideEntry';
import { useAccount } from '~/lib/core/account';
import { SHOW_CONSOLE_ENTRIES, consoleEntryUrls } from '~/lib/core/consoleEntries';
import { useT } from '~/lib/i18n/I18nProvider';
import { haptic } from '~/lib/platform/haptics';
import { openExternalUrl } from '~/lib/platform/links';
import { springs } from '~/lib/theme/tokens';

import {
  TAB_BAR,
  TAB_BAR_SHADOW,
  TAB_ICON_GAP,
  TAB_ICON_SIZE,
  TAB_LABEL,
  TAB_LABEL_COMPACT,
  TAB_LABEL_KEYS,
  TAB_LABEL_MAX_FONT_SCALE,
  TAB_ORDER,
  TAB_PILL,
  activeTabFor,
  isCompactLabel,
  shouldNavigateOnPress,
  tabPressParams,
  type TabName,
} from './tabBarModel';

const TAB_ICONS: Record<TabName, LucideIcon> = {
  index: Home,
  saved: Bookmark,
  waiting: Timer,
  course: Route,
  mypage: User,
};

export function TouristTabBar({ state, navigation, insets }: BottomTabBarProps) {
  const t = useT();
  const focusedName = state.routes[state.index]?.name;
  const active = activeTabFor(focusedName);
  const activeIndex = TAB_ORDER.indexOf(active);
  const keyboardShown = useKeyboardShown();

  const onTabPress = (tab: TabName) => {
    if (!shouldNavigateOnPress(tab, focusedName)) return;
    const route = state.routes.find((r) => r.name === tab);
    if (!route) return;
    const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
    if (event.defaultPrevented) return;
    haptic('selection');
    // 마이는 늘 마이 첫 화면으로(웹 router.push('/mypage')) — 열어 둔 하위 화면이 있으면 그 Stack 을 index 까지 pop 한다.
    navigation.navigate(route.name, tabPressParams(tab) ?? route.params);
  };

  if (keyboardShown) return null;

  return (
    <View
      className="border-t border-line bg-white/90"
      style={{
        boxShadow: TAB_BAR_SHADOW,
        paddingTop: TAB_BAR.paddingTop,
        paddingBottom: TAB_BAR.paddingBottom + insets.bottom,
        paddingLeft: TAB_BAR.paddingX + insets.left,
        paddingRight: TAB_BAR.paddingX + insets.right,
      }}
    >
      <GuideRow />
      <View
        accessibilityRole="tablist"
        className="relative w-full flex-row items-center justify-around"
        style={{ height: TAB_BAR.tabRow }}
      >
        <ActivePill index={activeIndex} count={TAB_ORDER.length} />
        {TAB_ORDER.map((tab) => (
          <TabItem
            key={tab}
            tab={tab}
            label={t(TAB_LABEL_KEYS[tab])}
            selected={tab === active}
            onPress={() => onTabPress(tab)}
          />
        ))}
      </View>
    </View>
  );
}

/** 활성 탭 알약 — 칸 폭(100/N %)의 틀을 옮기고 알약은 틀 가운데(웹 :182-191, interactionSpring). */
function ActivePill({ index, count }: { index: number; count: number }) {
  const reduceMotion = useReduceMotion();
  const [rowWidth, setRowWidth] = useState(0);
  const x = useSharedValue(0);
  const placed = useRef(false);
  const cell = rowWidth / count;

  useEffect(() => {
    if (cell <= 0) return;
    const target = index * cell;
    // 처음 자리 잡을 때와 동작 줄이기에서는 바로 옮긴다(웹 initial={false}).
    if (!placed.current || reduceMotion) {
      x.value = target;
      placed.current = true;
    } else {
      x.value = withSpring(target, springs.interaction);
    }
  }, [index, cell, reduceMotion, x]);

  const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const onLayout = (e: LayoutChangeEvent) => setRowWidth(e.nativeEvent.layout.width);

  return (
    <View pointerEvents="none" className="absolute inset-0" onLayout={onLayout}>
      {cell > 0 ? (
        // Reanimated Animated.View 는 NativeWind className 을 받지 않는다 — 배치는 style 로.
        <Animated.View
          style={[
            { position: 'absolute', top: 0, bottom: 0, left: 0, width: cell, alignItems: 'center', justifyContent: 'center' },
            style,
          ]}
        >
          <View
            className="bg-gold/15"
            style={{ width: TAB_PILL.width, height: TAB_PILL.height, borderRadius: TAB_PILL.radius }}
          />
        </Animated.View>
      ) : null}
    </View>
  );
}

function TabItem({
  tab,
  label,
  selected,
  onPress,
}: {
  tab: TabName;
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const compact = isCompactLabel(tab);
  const spec = compact ? TAB_LABEL_COMPACT : TAB_LABEL;
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      className="min-w-0 flex-1 items-center justify-center"
      style={{ height: TAB_BAR.tabRow }}
    >
      <View style={{ marginBottom: TAB_ICON_GAP }}>
        <Icon icon={TAB_ICONS[tab]} size={TAB_ICON_SIZE} color={selected ? 'gold-deep' : 'muk-soft'} />
      </View>
      {/* 앱 Text 로 그린다(글꼴·ja·zh 목록은 Text 가) — 줄 높이를 명시해 'My' 꼬리·가나·한자가 잘리지 않게(G2-R02). */}
      <Text
        weight="medium"
        numberOfLines={1}
        maxFontSizeMultiplier={TAB_LABEL_MAX_FONT_SCALE}
        className={selected ? 'text-gold-deep' : 'text-muk-soft'}
        style={spec}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** 안내 줄 — 왼쪽 서비스 소개, 오른쪽 콘솔 입구 둘(웹 :159-178). */
function GuideRow() {
  const t = useT();
  const { account } = useAccount();
  const urls = consoleEntryUrls(account);
  const consoles: { id: string; icon: LucideIcon; label: string; url: string }[] = SHOW_CONSOLE_ENTRIES
    ? [
        { id: 'merchant', icon: Store, label: t('nav.merchantShort'), url: urls.merchant },
        { id: 'admin', icon: Landmark, label: t('nav.adminShort'), url: urls.admin },
      ]
    : [];
  // 줄 높이 32 라 탭 영역 44 는 위아래 hitSlop 으로 채운다.
  const slop = { top: 6, bottom: 6, left: 0, right: 0 };
  return (
    <View
      className="flex-row items-center justify-between gap-[4px] border-b border-line"
      style={{
        height: TAB_BAR.guideRow,
        paddingBottom: TAB_BAR.guideRowPaddingBottom,
        marginBottom: TAB_BAR.guideRowMarginBottom,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('guide.title')}
        hitSlop={slop}
        onPress={openGuide}
        className="min-h-[32px] shrink-0 flex-row items-center justify-center gap-[8px] rounded-xl px-[4px]"
      >
        <Icon icon={CircleHelp} size={20} color="muk-soft" />
        <Text
          weight="medium"
          numberOfLines={1}
          maxFontSizeMultiplier={TAB_LABEL_MAX_FONT_SCALE}
          className="text-[12px] leading-[16px] text-muk-soft"
        >
          {t('guide.label')}
        </Text>
      </Pressable>
      <View className="min-w-0 shrink flex-row items-center gap-[4px]">
        {consoles.map((item) => (
          <Pressable
            key={item.id}
            accessibilityRole="link"
            hitSlop={slop}
            onPress={() => void openExternalUrl(item.url)}
            className="min-h-[32px] min-w-0 shrink flex-row items-center gap-[4px] rounded-lg px-[6px]"
          >
            <Icon icon={item.icon} size={14} color="muk-soft" />
            <Text
              weight="medium"
              numberOfLines={1}
              maxFontSizeMultiplier={TAB_LABEL_MAX_FONT_SCALE}
              className="shrink text-[12px] leading-[16px] text-muk-soft"
            >
              {item.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/** 키보드가 떠 있나(네이티브). iOS 는 will·안드로이드는 did 이벤트(react-navigation BottomTabBar 와 같다), 웹 빌드는 늘 false. */
function useKeyboardShown(): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const ios = Platform.OS === 'ios';
    const show = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', () => setShown(true));
    const hide = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () => setShown(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return shown;
}
