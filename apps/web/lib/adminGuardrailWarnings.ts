// 모델 신뢰도 가드레일 코드를 운영자가 바로 조치할 수 있는 문장으로 바꾼다.
// 관리자 화면은 다른 admin/* 화면과 같이 한국어 문구를 직접 사용한다.
// 새 코드는 진단용 code 필드에 보존하고 화면에는 공통 점검 안내를 표시한다.
//
// 문장은 **지금 사실**만 말한다(2026-10-31 P0-5). 예전 문구는 '실측이 누적되면 자동 승격됩니다' ·
// '다음 예약 학습에서 재시도됩니다' · '재학습이 예약되었습니다' 처럼 일어날지 모르는 일을 약속했다 — 주간 학습이
// 실패를 이어 가는 동안에도 화면은 안심시키는 말을 했다. 날짜·주기 같은 낡는 사실도 적지 않는다.

export interface GuardrailWarning {
  code: string;
  /** 무엇이 일어났는가. */
  text: string;
  /** 등록된 운영 문구가 있는 코드인가. */
  known: boolean;
}

const MESSAGES: Record<string, string> = {
  trained_false:
    '학습된 예측 모델 없음 — 추천은 취향·이동시간·혜택 규칙(SPOT)으로 계산하고 있습니다.',
  model_refresh_failure:
    '모델 갱신 실패 — 최근 모델 불러오기에서 오류가 났습니다. 서버 로그를 확인해 주세요.',
  untrusted_training_source:
    '활성 모델의 학습 자료에 시드·모의·단건 제보가 섞여 있습니다.',
  closed_place_recommended:
    '도착 시점에 영업 종료로 판정된 장소가 추천에 포함됐습니다 — 해당 시설의 영업시간 자료를 점검해 주세요.',
  ungrounded_numeric_exposure:
    '혼잡 근거 없이 수치가 노출된 추천이 있습니다 — 근거 연결을 점검해 주세요.',
  walk_limit_violation:
    '도보 한계를 넘는 추천이 있습니다.',
  active_model_mae_out_of_bounds:
    '활성 모델의 오차(MAE)가 기준(15%p)을 넘었습니다.',
  metrics_truncated:
    '조회 상한에 닿아 최신 구간만 집계했습니다 — 아래 수치는 기간 전체의 값이 아닙니다.',
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
