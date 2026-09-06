// 여정 재계획(ActiveJourneyCard) 결과 판정.
//
// 왜 파일로 뺐는가: 이 판정이 실제로 거짓말을 하고 있었다. 재계획은 세 가지 서로 다른 이유로
// 대체지 없이 끝나는데(서버가 조건에 맞는 곳을 0건 반환 / 응답 예산 초과 / 호출 실패),
// 코드는 셋을 하나의 불리언(replanEmpty)으로 합쳐 전부 '추천할 곳이 없어요' 로 내보냈다.
// 사용자는 장애를 자기 조건 탓으로 읽고 조건을 바꾸지만, 조건을 바꿔도 결과는 같다.
//
// '못 찾았다' 와 '알아내지 못했다' 는 다른 사실이다. 여기서 그 구분을 잠근다.

/** 재계획 시도의 결말. */
export type ReplanOutcome =
  /** 대체지를 찾아 여정을 갈아탔다. */
  | 'replaced'
  /** 서버가 정상 응답했고, 조건에 맞는 곳이 0건이었다 — 조건을 바꾸면 달라질 수 있다. */
  | 'empty'
  /** 응답 예산(REPLAN_RESPONSE_BUDGET_MS) 안에 답이 오지 않았다 — 0건이라는 뜻이 아니다. */
  | 'timeout'
  /** 호출 자체가 실패했다(네트워크·서버 오류). */
  | 'failed';

/** 화면에 띄울 안내. `retryable` 이면 같은 조건으로 다시 시도할 경로를 준다. */
export interface ReplanNotice {
  messageKey: string;
  retryable: boolean;
}

/**
 * 정상 응답 경로의 결말을 고른다.
 *
 * `timedOut` 이 우선한다: 예산을 넘긴 시점에 손에 든 후보는 이번 시도의 답이 아니므로
 * (아직 오지 않았다) 0건을 '없다' 로 옮겨 적지 않는다.
 */
export function classifyReplanOutcome(input: { timedOut: boolean; candidateCount: number }): ReplanOutcome {
  if (input.timedOut) return 'timeout';
  return input.candidateCount > 0 ? 'replaced' : 'empty';
}

/**
 * 결말에 붙일 안내를 고른다. 새 문구를 만들지 않고 기존 키를 재사용한다
 * (`map.noRecBody` = 조건을 바꿔 보라는 안내, `recommend.loadFailed` = 못 불러왔으니 다시 시도).
 * 성공(replaced)은 할 말이 없다 — null.
 */
export function replanNotice(outcome: ReplanOutcome): ReplanNotice | null {
  switch (outcome) {
    case 'replaced':
      return null;
    case 'empty':
      // 조건 문제다. 여기에 '다시 시도' 를 달면 같은 답이 나올 일을 시키는 셈이다.
      return { messageKey: 'map.noRecBody', retryable: false };
    case 'timeout':
    case 'failed':
      // 장애다. 조건을 바꿔도 소용없으니 재시도 경로를 준다.
      return { messageKey: 'recommend.loadFailed', retryable: true };
  }
}
