# 결정 품질 요약 (`crowd/data/decision_quality`)

서울 테스트베드 S4 분산 결정 재생이 만든 **권역별 집계 요약**을 두는 자리다. 관리자 '엔진 검증' 화면
(`/admin/engine-validation`, developer 전용)의 결정 품질 카드가 이 폴더를 읽는다
(`app/services/crowd/decision_quality.py` → `GET /api/v1/admin/engine-validation/seoul/summary` 의 `decision_quality`).

## 여기에 두는 것

- **`<cluster>.json` 하나씩만** — `hongdae.json`, `jongno.json`. 재생 명령이 만든 `out/decision_quality/<cluster>.json` 을
  **이름·내용 그대로** 복사한다(손으로 고치지 않는다).

  ```bash
  cd apps/api
  .venv/Scripts/python scripts/crowd_dispersion_replay.py run --cluster hongdae --data-dir <반출 폴더> --label pilot
  # 검토 뒤: out/decision_quality/hongdae.json → 이 폴더
  ```

- 스키마는 `decision_quality_summary/3`(≤ 16KB, 어느 배열도 16개 이하, 결정 행 없음). `population` 은 `crowded_origin_choice_feasible`(붐비는 출발지 중 대안 2곳 이상 — V3 모집단)이어야 한다.
- 파일 이름(확장자 뺀 부분)은 파일 안의 `cluster` 와 같아야 하고, `cluster` 는 `seoul_provider.SEOUL_ZONES` 의 권역이어야 한다.

## 두지 않는 것

- **원본 반출 CSV·결정 추적 CSV·전체 보고서는 절대 두지 않는다.** 원본은 저장소 밖이나 `apps/api/.replay-data/`
  (git·docker 무시)에만 둔다. 전체 보고서(`<cluster>_replay_report.json`)·요약 마크다운은 필요하면 `docs/archive/reports/` 에 둔다.

## 화면이 보이는 것

| 폴더 상태 | `decision_quality.state` | 화면 |
|---|---|---|
| `*.json` 없음 | `not_evaluated` | 'S4 재생 평가 전 — 아직 없음'(S4 전과 같은 응답) |
| 모든 파일이 검사 통과 | `evaluated` | 권역마다 카드 하나(cluster 이름순) |
| 한 파일이라도 틀림 | `invalid_summary` | 숫자 없이 `<파일명>: <문제>` 만. 나머지 권역도 싣지 않는다 |

틀린 파일은 API 를 5xx 로 만들지 않는다(경고 로그 `decision_quality_summary_invalid`). 검사 규칙은
`tests/services/test_crowd_decision_quality.py` 가 실제 재생 산출물로 잠근다.
