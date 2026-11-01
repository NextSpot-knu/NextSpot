import type { ReactNode } from 'react';
import { ScrollView, View, type ScrollViewProps } from 'react-native';
import { useSafeAreaInsets, type Edge } from 'react-native-safe-area-context';

import { CONTENT_MAX_WIDTH } from '~/lib/theme/tokens';

import { cn, withDefault } from './cn';

export type ScreenProps = {
  children?: ReactNode;
  /** 안전 영역을 비울 가장자리. 기본은 위·아래·옆 전부. 탭 화면(탭 막대가 아래를 맡는다)이나 헤더가 있는 화면은 ['left','right'] 등. */
  edges?: readonly Edge[];
  /** 세로 스크롤 화면. 키보드·당겨서 새로고침 등은 scrollProps 로. */
  scroll?: boolean;
  scrollProps?: Omit<ScrollViewProps, 'children' | 'contentContainerStyle'>;
  /**
   * 내용 최대 폭(pt) — 펼친 폴더블(Z Fold7)·태블릿 폭에서 가운데 정렬한다. 지도처럼 화면을 꽉 채울 화면은 false.
   * 기본 640.
   */
  maxWidth?: number | false;
  /** 바탕. 기본 한지(bg-hanji). */
  className?: string;
  /** 내용 상자 클래스(여백 등). 기본 px-[16px]. */
  contentClassName?: string;
};

const ALL_EDGES: readonly Edge[] = ['top', 'bottom', 'left', 'right'];

/**
 * 화면 틀 — 한지 바탕 + 안전 영역 + 가운데 최대 폭. app/ 의 화면은 이것으로 시작한다.
 * SafeAreaView 대신 insets 를 직접 써서 NativeWind className 과 섞어도 여백이 겹치지 않게 했다.
 */
export function Screen({
  children,
  edges = ALL_EDGES,
  scroll = false,
  scrollProps,
  maxWidth = CONTENT_MAX_WIDTH,
  className,
  contentClassName = 'px-[16px]',
}: ScreenProps) {
  const insets = useSafeAreaInsets();
  const bg = withDefault(className, /^bg-/, 'bg-hanji');
  const pad = {
    paddingTop: edges.includes('top') ? insets.top : 0,
    paddingBottom: edges.includes('bottom') ? insets.bottom : 0,
    paddingLeft: edges.includes('left') ? insets.left : 0,
    paddingRight: edges.includes('right') ? insets.right : 0,
  };
  const width = maxWidth === false ? undefined : { width: '100%' as const, maxWidth, alignSelf: 'center' as const };
  if (scroll) {
    return (
      <View className={cn('flex-1', bg)}>
        <ScrollView
          {...scrollProps}
          contentContainerStyle={[pad, { flexGrow: 1 }]}
          keyboardShouldPersistTaps={scrollProps?.keyboardShouldPersistTaps ?? 'handled'}
        >
          <View className={cn('flex-1', contentClassName)} style={width}>
            {children}
          </View>
        </ScrollView>
      </View>
    );
  }
  return (
    <View className={cn('flex-1', bg)} style={pad}>
      <View className={cn('flex-1', contentClassName)} style={width}>
        {children}
      </View>
    </View>
  );
}
