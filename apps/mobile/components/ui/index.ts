/**
 * NextSpot 앱 디자인 시스템 — 화면은 여기서 import 한다: `import { Button, Text, Screen } from '~/components/ui'`.
 * 토큰(색·그라데이션·그림자·글꼴·스프링)은 `~/lib/theme/tokens`. 웹 globals.css 와 같은 이름이고 tokens.test.ts 가 어긋남을 잡는다.
 *
 * ── 웹 스타일을 옮기는 규칙(docs/MOBILE_APP_PLAN.md §9.1) ──────────────────────────────────────
 * 1. 클래스 이름은 웹 그대로: bg-hanji · bg-hanji-deep · text-muk · text-muk-soft · border-line · text-gold-deep · bg-jade/10 ….
 *    투명도 꼬리(/10 · /25)도 된다. 웹 `@theme` 의 색은 전부 같은 이름으로 있다.
 * 2. 글자는 늘 `Text`(이 폴더)로. RN 은 글자 스타일이 부모 View 에서 상속되지 않는다 — 색·크기·굵기를 Text 에 직접 준다.
 *    `font-bold` 같은 굵기 클래스는 Text 가 굵기별 글꼴로 바꾼다(안드로이드는 굵기마다 글꼴 이름이 따로다). RN Text 를
 *    직접 쓰면 굵어지지 않는다. 한국어 낱말 단위 줄바꿈(웹 break-keep)은 Text 가 기본으로 한다.
 * 3. 크기는 px 로 적는다: text-[14px] · min-h-[44px] · px-[16px]. NativeWind 는 rem 을 14px 로 계산해(웹은 16px)
 *    text-sm · p-4 · h-11 이 웹보다 작게 나온다 — metro 의 inlineRem 이 16 이 되기 전까지는 px 가 안전하다.
 * 4. 같은 속성 클래스 둘(text-sm 과 text-base, border-line 과 border-jade)을 한 요소에 같이 주지 않는다. 웹처럼
 *    '나중 것이 이긴다' 가 아니다(tailwind-merge 없음). 조건부는 삼항으로 한쪽만, 덮어써야 하면 style 로.
 * 5. grid → `flex-row flex-wrap gap-[8px]` + 자식 폭(w-[48%] 등). grid-cols-* 는 없다.
 * 6. 그라데이션(bg-gradient-to-* · .cta-primary · .gradient-text) → `Gradient`(expo-linear-gradient). 주 버튼은 `Button`
 *    variant="primary" 가 이미 그린다. 글자 그라데이션은 없다 — text-gold-deep 단색.
 * 7. 유리(.liquid-glass · backdrop-blur · .rail-glass) → `Glass`. iOS 는 expo-blur, 안드로이드는 거의 불투명한 판(흐림 없음).
 *    탐색 층에만, 유리 위에 유리를 겹치지 않는다. 유리 안 보조 글자는 text-glass-muk-soft · text-glass-gold-deep.
 * 8. hover: · focus-visible: · transition-* · cursor-* → 버린다. 누름 피드백은 `Pressable`(0.96 줄어듦, 웹 .toss-pressable).
 *    active:scale-* 를 같이 쓰지 않는다(두 번 줄어든다).
 * 9. color-mix(…) · bg-[color-mix(...)] → tokens 에 미리 계산한 색(예: 선택 칩 bg-jade-chip, 장소 표지 bg-tile-slate-bg).
 *    새로 필요하면 tokens.ts 에 더하고 tokens.test.ts 에 계산식을 적는다.
 * 10. 그림자 shadow-[…] → style={{ boxShadow: shadows.card }}(tokens). 임의 그림자 클래스는 쓰지 않는다.
 * 11. 탭 영역 44pt: 누를 수 있는 것은 min-h-[44px], 보이는 크기가 작으면 hitSlop 으로 44 를 채운다(웹 .tap-target).
 *     아이콘만 있는 버튼은 accessibilityLabel 필수. 누를 수 있는 것에는 accessibilityRole="button".
 * 12. dvh · vh · fixed · sticky · z-* 쌓기 → Screen · Sheet · 절대 배치(absolute)로. 화면 내용은 Screen 이 가운데 최대 640pt.
 * 13. 이모지는 그대로 Text 로 쓴다. 장식이면 accessibilityElementsHidden.
 * 14. 다크 모드(dark:)는 없다 — 앱은 라이트만.
 */
export { Button, type ButtonProps, type ButtonVariant } from './Button';
export { Card, type CardProps } from './Card';
export { Chip, type ChipProps } from './Chip';
export { cn, withDefault } from './cn';
export { EmptyState, type EmptyStateProps } from './EmptyState';
export { ErrorState, type ErrorStateProps } from './ErrorState';
export { Glass, useReduceTransparency, type GlassProps } from './Glass';
export { Gradient, type GradientName, type GradientProps } from './Gradient';
export { Icon, type IconProps } from './Icon';
export { Pressable, type PressableProps } from './Pressable';
export { Screen, type ScreenProps } from './Screen';
export {
  ModalSheet,
  Sheet,
  SheetScrollView,
  SheetView,
  type ModalSheetProps,
  type SheetProps,
  type SheetState,
} from './Sheet';
export { Skeleton, type SkeletonProps } from './Skeleton';
export { Text, weightFromClassName, type TextProps } from './Text';
export { AppToaster, toast } from './Toast';
