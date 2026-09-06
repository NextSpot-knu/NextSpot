// 재계획 결과를 뭐라고 말할 것인가 — 순수 판정만 모은다.
//
// 왜 컴포넌트에서 뺐나: 이 판정이 실제로 거짓말을 했다. 예전 구현은 **추가된 정류지만** 세고
// 제거는 세지 않아서, [A,B,C] → [A,B] 처럼 한 곳이 빠진 재계획을 "같은 곳들을 순서만 바꿔
// 다시 계산했어요" 라고 말했다. 장소가 같다는 것도, 순서가 바뀌었다는 것도 거짓이었다.
// course/page.tsx 안에 있으면 이 결정에 테스트를 붙일 수 없다(React·i18n·네트워크가 딸려 온다).
//
// ⚠️ 여기서 문장을 만들지 않는다. i18n 키와 치환값만 돌려준다 — 로케일이 넷이다.

/** 이전 계획의 요약. planId 는 서버가 준 '선택된 시설 열' 의 해시다. */
export interface PlanSnapshot {
  planId: string;
  ids: string[];
}

export interface ReplanMessage {
  key: string;
  vars?: Record<string, number>;
}

/**
 * 무엇이 달라졌는지 정직하게 고른다. 말할 것이 없으면 null(토스트를 띄우지 않는다).
 *
 * null 을 돌려주는 경우가 둘이다.
 *   · 판정할 근거가 없다 — planId 가 비었다(구 API 폴백). 지어내지 않고 침묵한다.
 *   · 코스가 비었다 — 화면이 이미 EmptyState 로 **왜** 비었는지 말한다. 그 위에
 *     "다시 짰어요" 를 얹으면 0곳을 무언가 있는 것처럼 말하게 된다.
 */
export function describeReplan(
  prev: PlanSnapshot | null,
  next: PlanSnapshot,
): ReplanMessage | null {
  if (!next.planId || !prev?.planId) return null;
  if (next.ids.length === 0) return null;

  if (prev.planId === next.planId) return { key: 'course.replanSame' };

  const prevIds = new Set(prev.ids);
  const nextIds = new Set(next.ids);
  const added = next.ids.filter((id) => !prevIds.has(id)).length;
  const removed = prev.ids.filter((id) => !nextIds.has(id)).length;

  // planId 가 다른데 집합이 같다 = 순서만 바뀌었다. 이때만 '순서만' 이라고 말할 수 있다.
  if (added === 0 && removed === 0) return { key: 'course.replanReordered' };
  if (added === 0) return { key: 'course.replanRemoved', vars: { n: removed } };
  if (removed === 0) return { key: 'course.replanChanged', vars: { n: added } };
  return { key: 'course.replanSwapped', vars: { added, removed } };
}
