// 웹 빌드 접근성 속성(F6) — react-native-web 0.21 은 accessibilityState 를 DOM 으로 옮기지 않고 납작한 aria-* prop 만 받는다
// (G1-34·G5b-06). 그래서 Pressable 한 곳에서 펼친다. 네이티브는 accessibilityState 를 TalkBack·VoiceOver 가 이미 읽으므로 그대로 둔다.
export type A11yStateLike = {
  selected?: boolean;
  checked?: boolean | 'mixed';
  expanded?: boolean;
  busy?: boolean;
  disabled?: boolean;
};

export type WebAriaProps = {
  'aria-selected'?: boolean;
  'aria-pressed'?: boolean;
  'aria-checked'?: boolean | 'mixed';
  'aria-expanded'?: boolean;
  'aria-busy'?: boolean;
};

/**
 * role=tab 의 selected → aria-selected, radio·checkbox 의 selected → aria-checked, 그 밖의 selected → aria-pressed(웹 칩·토글이 쓰는 것),
 * checked → aria-checked, expanded → aria-expanded, busy → aria-busy(true 일 때만 — 모든 버튼에 aria-busy=false 가 붙지 않게).
 */
export function webAriaProps(role: string | undefined, state: A11yStateLike | null | undefined): WebAriaProps {
  const out: WebAriaProps = {};
  if (!state) return out;
  if (state.selected !== undefined) {
    if (role === 'tab') out['aria-selected'] = state.selected;
    else if (role === 'radio' || role === 'checkbox') out['aria-checked'] = state.selected;
    else out['aria-pressed'] = state.selected;
  }
  // checked 를 직접 준 것이 selected 로 옮긴 값보다 이긴다.
  if (state.checked !== undefined) out['aria-checked'] = state.checked;
  if (state.expanded !== undefined) out['aria-expanded'] = state.expanded;
  if (state.busy === true) out['aria-busy'] = true;
  return out;
}
