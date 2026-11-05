import { createContext, forwardRef, useContext } from 'react';
import { Platform, Text as RNText, type TextProps as RNTextProps } from 'react-native';

import { fontFamilies, weightClassToName, type FontWeightName } from '~/lib/theme/tokens';

import { getCurrentLocale } from '~/lib/i18n/localeState';

import { TEXT_SIZE_CLASS, isTextColorClass, withDefault } from './cn';
import { keepKoreanWordsInChildren, stripWordJoiners } from './koreanWordKeep';

export type TextProps = RNTextProps & {
  className?: string;
  /** 굵기. 없으면 className 의 font-medium·font-bold 등을 읽고, 그것도 없으면 regular(겹친 Text 면 부모 굵기). */
  weight?: FontWeightName;
};

/**
 * 큰 글자 설정에서 글자가 커지는 최대 배율 기본값. 그 이상은 칩·탭·버튼 줄이 넘쳐 읽기 어려워진다.
 * 필요한 곳(본문 문단)은 maxFontSizeMultiplier 를 직접 넘겨 더 키우거나 0(제한 없음)으로 둔다.
 */
export const DEFAULT_MAX_FONT_SCALE = 1.6;

/** Text 안의 Text 인가 — 겹친 Text 는 부모의 색·크기·굵기를 물려받아야 한다(RN 은 Text 안에서는 상속한다). */
const NestedText = createContext(false);

/** className 에서 마지막 font-(normal|medium|semibold|bold|extrabold|black|[650]|[750]…) 를 굵기 이름으로. */
export function weightFromClassName(className: string | undefined): FontWeightName | undefined {
  let found: FontWeightName | undefined;
  for (const c of (className ?? '').split(/\s+/)) {
    const name = weightClassToName[c];
    if (name) found = name;
  }
  return found;
}

/**
 * 앱의 모든 글자. RN 은 글자 스타일이 부모 View 에서 상속되지 않으므로 글자마다 이것을 쓴다.
 * - 글꼴: Freesentation 을 굵기별 family 로 고른다(안드로이드는 font-bold 만으로는 굵어지지 않는다).
 *   그래서 fontWeight 는 normal 로 되돌린다 — 이미 굵은 파일에 굵게를 또 걸면 안드로이드가 가짜로 한 번 더 굵힌다.
 * - 기본값: text-muk · 16px. className 에 같은 종류(글자 색·크기)가 있으면 기본값을 붙이지 않는다.
 *   Text 안에 겹친 Text 는 기본값을 붙이지 않는다 — 부모의 색·크기·굵기를 물려받는다(굵기를 주면 그 글꼴로 바꾼다).
 * - 큰 글자: maxFontSizeMultiplier 기본 1.6(DEFAULT_MAX_FONT_SCALE). 겹친 Text 에는 기본값을 주지 않는다 — 바깥 Text 가
 *   본문을 더 키우려고(또는 0 으로 풀려고) 준 값을 안쪽 조각이 1.6 으로 다시 묶지 않게(명시해서 넘긴 값만 쓴다).
 * - 한국어 줄바꿈: iOS 는 낱말 단위(hangul-word) — 웹 word-break: keep-all 과 같은 뜻. 안드로이드는 그런 옵션이 없어 음절마다 끊기므로
 *   ko 일 때 낱말 안 한글 사이에 U+2060 을 넣는다(koreanWordKeep.ts). 읽기 화면에는 U+2060 을 뺀 글을 넘긴다.
 */
export const Text = forwardRef<RNText, TextProps>(function Text({ className, weight, style, children, ...rest }, ref) {
  const nested = useContext(NestedText);
  const explicit = weight ?? weightFromClassName(className);
  const resolved = explicit ?? (nested ? undefined : 'regular');
  let classes = className ?? '';
  if (!nested) {
    classes = withDefault(classes, isTextColorClass, 'text-muk');
    classes = withDefault(classes, TEXT_SIZE_CLASS, 'text-[16px]');
  }
  const keepWords = Platform.OS === 'android' && getCurrentLocale() === 'ko';
  const shown = keepWords ? keepKoreanWordsInChildren(children) : children;
  const label =
    typeof rest.accessibilityLabel === 'string'
      ? stripWordJoiners(rest.accessibilityLabel)
      : keepWords && typeof children === 'string'
        ? children
        : rest.accessibilityLabel;
  return (
    <RNText
      ref={ref}
      className={classes || undefined}
      lineBreakStrategyIOS="hangul-word"
      maxFontSizeMultiplier={nested ? undefined : DEFAULT_MAX_FONT_SCALE}
      style={[resolved ? { fontFamily: fontFamilies[resolved], fontWeight: 'normal' } : null, style]}
      {...rest}
      accessibilityLabel={label}
    >
      {nested ? shown : <NestedText.Provider value>{shown}</NestedText.Provider>}
    </RNText>
  );
});
