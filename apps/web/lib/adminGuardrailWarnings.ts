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

// 문구 원칙(2026-09-21 PM 지시): 자기 결점 고백("없습니다·실패했습니다·폴백")이 아니라
// **운영 상태 + 다음 행동**으로 말한다. 같은 사실을 관제 언어로 전달하되 서비스를 깎아내리지 않는다.
const MESSAGES: Record<string, string> = {
  trained_false:
    '취향·이동시간·혜택 3축 SPOT 엔진으로 실시간 추천 중 — 실측이 누적되면 학습 모델로 자동 승격됩니다.',
  model_refresh_failure:
    '모델 갱신이 다음 예약 학습에서 재시도됩니다 — 현재 모델로 예측을 계속 제공합니다.',
  untrusted_training_source:
    '학습 데이터 출처를 등급별로 분리 관리 중입니다 — 상호확인된 실측만 모델 학습에 사용합니다.',
  closed_place_recommended:
    '영업시간 판정 확인이 필요한 추천이 감지되었습니다 — 해당 시설의 영업시간 데이터를 점검해 주세요.',
  ungrounded_numeric_exposure:
    '수치 근거 연결 확인이 필요한 추천이 감지되었습니다 — 실측 근거 매칭을 점검해 주세요.',
  walk_limit_violation:
    '도보 한계 조건 검토가 필요한 추천이 감지되었습니다.',
  active_model_mae_out_of_bounds:
    '활성 모델 오차(MAE)가 기준(0.15)을 넘어 재학습 대상으로 지정되었습니다.',
  metrics_truncated:
    '표본 상한으로 일부 기간만 집계되었습니다 — 조회 기간을 좁히면 전체 값을 확인할 수 있습니다.',
};

export function describeGuardrailWarnings(codes: readonly string[] | null | undefined): GuardrailWarning[] {
  if (!Array.isArray(codes)) return [];
  return codes
    .filter((code): code is string => typeof code === 'string' && code.trim().length > 0)
    .map((code) => {
      const text = MESSAGES[code];
      return text
        ? { code, text, known: true }
        : { code, text: `점검 코드: ${code}`, known: false };
    });
}
