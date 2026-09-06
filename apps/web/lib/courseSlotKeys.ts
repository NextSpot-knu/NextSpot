// 화면에 붙어 있는 자리 키가 아직 '지금의 입력' 과 같은가 — 순수 판정만 둔다.
//
// 왜 필요한가: 코스 화면의 고정(pin)·'여기로 바꾸기' 는 **자리 키**로 동작한다.
// 화면은 응답과 함께 굳힌 `renderedSlotKeys` 로 행을 그리고, 요청은 현재 입력에서 파생한
// `slotKeys` 로 자리 번호를 만든다(`slotKeys.indexOf(key) + 1`). 두 배열이 어긋나면
// indexOf 가 -1 이라 그 핀은 `order > 0` 필터에서 **조용히 사라진다.**
//
// 어긋나는 창이 실제로 존재한다: 사용자가 순서를 바꾸면 slotKeys 는 즉시 바뀌지만
// 새 계획은 디바운스 500ms + 왕복 뒤에야 온다. 그 사이 화면에는 옛 행이 그대로 남아 있고,
// 거기서 '여기로 바꾸기' 를 누르면 **아무 일도 일어나지 않았다.** 브라우저로 재현해 확인했다
// (2026-09-07). 그 창 동안에는 조작을 아예 내리는 것이 이 화면의 기존 규칙과 같다
// — course/page.tsx 의 StopRows 주석: "눌러도 아무 일도 일어나지 않는 조작을 준 셈이 된다".

/** 표시 중인 자리 키가 현재 입력의 자리 키와 다른가(= 보이는 행이 지나간 계획의 것인가). */
export function slotKeysStale(rendered: readonly string[], current: readonly string[]): boolean {
  if (rendered.length !== current.length) return true;
  return rendered.some((key, i) => key !== current[i]);
}
