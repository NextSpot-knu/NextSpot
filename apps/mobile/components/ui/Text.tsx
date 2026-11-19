import { createContext, forwardRef, useContext } from 'react';
import { Platform, StyleSheet, Text as RNText, type TextProps as RNTextProps, type TextStyle } from 'react-native';

import { weightClassToName, type FontWeightName } from '~/lib/theme/tokens';

import { useOptionalLocale } from '~/lib/i18n/I18nProvider';

import { TEXT_SIZE_CLASS, isTextColorClass, withDefault } from './cn';
import { useGlassTone } from './glassContext';
import { keepKoreanWordsInChildren, stripWordJoiners } from './koreanWordKeep';
import { defaultLineHeight, fontStyleFor, glassTextColor } from './textStyle';

const PLATFORM = Platform.OS === 'web' ? 'web' : 'native';

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
 *   네이티브는 fontWeight 를 normal 로 되돌린다 — 이미 굵은 파일에 굵게를 또 걸면 안드로이드가 가짜로 한 번 더 굵힌다.
 *   웹 빌드는 대체 글꼴 목록을 붙이고(G2-R03), ja·zh 는 웹과 같은 시스템 글꼴 목록(G2-G04) — 규칙은 textStyle.ts fontStyleFor.
 * - 기본값: text-muk · 16px. className 에 같은 종류(글자 색·크기)가 있으면 기본값을 붙이지 않는다.
 *   Text 안에 겹친 Text 는 기본값을 붙이지 않는다 — 부모의 색·크기·굵기를 물려받는다(굵기를 주면 그 글꼴로 바꾼다).
 * - 줄 높이: 아무도 정하지 않았으면 크기×1.5(웹 preflight, G2-G05). className 의 leading-*·이름 크기(text-xs~)·style.lineHeight 가
 *   있으면 붙이지 않는다 — 규칙은 textStyle.ts defaultLineHeight. 겹친 Text 는 부모 줄 높이를 따른다.
 * - 유리(Glass) 안: 보조 글자(muk-soft·gold-deep)를 유리용 진한 색으로(G2-G03).
 * - 큰 글자: maxFontSizeMultiplier 기본 1.6(DEFAULT_MAX_FONT_SCALE). 겹친 Text 에는 기본값을 주지 않는다 — 바깥 Text 가
 *   본문을 더 키우려고(또는 0 으로 풀려고) 준 값을 안쪽 조각이 1.6 으로 다시 묶지 않게(명시해서 넘긴 값만 쓴다).
 * - 한국어 줄바꿈: iOS 는 낱말 단위(hangul-word) — 웹 word-break: keep-all 과 같은 뜻. 안드로이드는 그런 옵션이 없어 음절마다 끊기므로
 *   ko 일 때 낱말 안 한글 사이에 U+2060 을 넣는다(koreanWordKeep.ts). 읽기 화면에는 U+2060 을 뺀 글을 넘긴다.
 *   웹 빌드는 CSS 한 곳(lib/webSetup.web.ts 의 html:lang(ko) keep-all, G2-G06)이 맡는다 — 여기서는 하지 않는다.
 */
export const Text = forwardRef<RNText, TextProps>(function Text({ className, weight, style, children, ...rest }, ref) {
  const nested = useContext(NestedText);
  const locale = useOptionalLocale();
  const tone = useGlassTone();
  const explicit = weight ?? weightFromClassName(className);
  const resolved = explicit ?? (nested ? undefined : 'regular');
  let classes = className ?? '';
  if (!nested) {
    classes = withDefault(classes, isTextColorClass, 'text-muk');
    classes = withDefault(classes, TEXT_SIZE_CLASS, 'text-[16px]');
  }
  const keepWords = Platform.OS === 'android' && locale === 'ko';
  const lineHeight = nested ? undefined : defaultLineHeight(classes, StyleSheet.flatten(style) as TextStyle | undefined);
  const glassColor = glassTextColor(classes, tone);
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
      style={[
        resolved ? fontStyleFor(resolved, locale, PLATFORM) : null,
        lineHeight != null ? { lineHeight } : null,
        glassColor ? { color: glassColor } : null,
        style,
      ]}
      {...rest}
      accessibilityLabel={label}
    >
      {nested ? shown : <NestedText.Provider value>{shown}</NestedText.Provider>}
    </RNText>
  );
});
