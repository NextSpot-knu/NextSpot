// 모델 신뢰도 가드레일 코드를 운영자가 바로 조치할 수 있는 문장으로 바꾼다.
// 관리자 화면은 다른 admin/* 화면과 같이 한국어 문구를 직접 사용한다.
// 새 코드는 진단용 code 필드에 보존하고 화면에는 공통 점검 안내를 표시한다.

export interface GuardrailWarning {
  code: string;
  /** 무엇이 일어났는가. */
  text: string;
  /** 등록된 운영 문구가 있는 코드인가. */
  known: boolean;
}

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
    '모델 정확도 재학습이 예약되었습니다 — 현재 모델로 예측을 계속 제공합니다.',
  metrics_truncated:
    '최신 구간 기준으로 집계했습니다 — 기간을 좁히면 전체 값을 볼 수 있습니다.',
};

export function describeGuardrailWarnings(codes: readonly string[] | null | undefined): GuardrailWarning[] {
  if (!Array.isArray(codes)) return [];
  return codes
    .filter((code): code is string => typeof code === 'string' && code.trim().length > 0)
    .map((code) => {
      const text = MESSAGES[code];
      return text
        ? { code, text, known: true }
        : { code, text: '운영 점검 항목이 추가되었습니다 — 상세는 운영 로그에서 확인해 주세요.', known: false };
    });
}
