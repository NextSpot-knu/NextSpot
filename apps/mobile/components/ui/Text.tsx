import { forwardRef } from 'react';
import { Text as RNText, type TextProps as RNTextProps } from 'react-native';

import { fontFamilies, weightClassToName, type FontWeightName } from '~/lib/theme/tokens';

import { TEXT_SIZE_CLASS, isTextColorClass, withDefault } from './cn';

export type TextProps = RNTextProps & {
  className?: string;
  /** 굵기. 없으면 className 의 font-medium·font-bold 등을 읽고, 그것도 없으면 regular. */
  weight?: FontWeightName;
};

/** className 에서 마지막 font-(normal|medium|semibold|bold|extrabold|black) 를 굵기 이름으로. */
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
 * - 한국어 줄바꿈: iOS 는 낱말 단위(hangul-word) — 웹 word-break: keep-all 과 같은 뜻. 안드로이드는 기본이 낱말 단위다.
 */
export const Text = forwardRef<RNText, TextProps>(function Text({ className, weight, style, ...rest }, ref) {
  const resolved = weight ?? weightFromClassName(className) ?? 'regular';
  let classes = withDefault(className, isTextColorClass, 'text-muk');
  classes = withDefault(classes, TEXT_SIZE_CLASS, 'text-[16px]');
  return (
    <RNText
      ref={ref}
      className={classes}
      lineBreakStrategyIOS="hangul-word"
      style={[{ fontFamily: fontFamilies[resolved], fontWeight: 'normal' }, style]}
      {...rest}
    />
  );
});
