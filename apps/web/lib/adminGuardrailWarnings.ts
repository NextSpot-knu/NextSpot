// 모델 신뢰도 가드레일 경고 코드 → 운영자가 읽고 **행동할 수 있는** 문장.
//
// 왜 필요한가: 화면이 `data.guardrails.warnings` 를 `join(' · ')` 로 그대로 이어 붙여서
// 관리자에게 `trained_false · ungrounded_numeric_exposure` 처럼 보였다. 코드를 읽을 수 있는
// 사람은 이 저장소를 아는 사람뿐이고, 그런 사람은 이 화면을 볼 필요가 없다.
//
// 관리자 화면은 한국어 하드코딩이라 i18n 을 타지 않는다(다른 admin/* 화면과 동일).
//
// ⚠️ 모르는 코드는 **숨기지 않는다.** 매핑에 없다고 지우면 백엔드가 새 경고를 붙였을 때
// 화면에서 조용히 사라진다 — 경고를 없애는 가장 나쁜 방법이다. 코드 원문을 그대로 보여준다.

export interface GuardrailWarning {
  code: string;
  /** 무엇이 일어났는가. */
  text: string;
  /** 매핑에 있는 코드인가(모르는 코드는 원문 노출). */
  known: boolean;
}

const MESSAGES: Record<string, string> = {
  trained_false:
    '학습된 모델이 없습니다 — 혼잡 예측이 규칙 폴백으로 동작 중입니다.',
  model_refresh_failure:
    '모델 갱신에 실패했습니다 — 지금 쓰는 모델이 최신이 아닐 수 있습니다.',
  untrusted_training_source:
    '학습 데이터에 신뢰할 수 없는 출처(seed·simulated·synthetic·단일 제보)가 섞였습니다.',
  closed_place_recommended:
    '영업이 끝난 곳이 추천에 나갔습니다 — 영업시간 판정을 확인해 주세요.',
  ungrounded_numeric_exposure:
    '근거 없는 수치가 사용자에게 노출됐습니다 — 실측 없이 숫자를 말한 추천이 있습니다.',
  walk_limit_violation:
    '사용자가 정한 도보 한계를 넘는 곳이 추천됐습니다.',
  active_model_mae_out_of_bounds:
    '활성 모델의 MAE 가 허용치(0.15)를 넘었습니다 — 재학습이 필요합니다.',
  metrics_truncated:
    '조회가 상한에서 잘렸습니다 — 아래 수치는 기간 전체의 값이 아닙니다. 특히 ‘관측 공백 시설’ 은 실제로는 관측되는 곳을 잘못 지목할 수 있습니다.',
};

export function describeGuardrailWarnings(codes: readonly string[] | null | undefined): GuardrailWarning[] {
  if (!Array.isArray(codes)) return [];
  return codes
    .filter((code): code is string => typeof code === 'string' && code.trim().length > 0)
    .map((code) => {
      const text = MESSAGES[code];
      return text
        ? { code, text, known: true }
        : { code, text: `알 수 없는 경고 코드: ${code}`, known: false };
    });
}
