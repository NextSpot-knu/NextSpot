# MODEL CARD — NextSpot 혼잡 예측 모델

## 운영 계약

- 운영 추론은 비공개 Supabase Storage `recommendation-models`의 아티팩트만 사용한다.
- `model_registry.status='active'` 한 건을 SHA-256, 피처 스키마, 실데이터 수와 품질 지표까지
  검증한 뒤 메모리에 원자적으로 적재한다. 저장소의 `apps/api/model.pkl`은 개발 참고용이며
  운영 로더가 읽지 않는다.
- 활성 모델이 없거나 다운로드·해시·스키마·품질 검증이 실패하면 `degraded_rules`로 동작한다.
  이 모드에서는 취향, 실제 이동시간, 혜택만 점수에 쓴다. 임의 0.5 예측·예상 대기시간은 만들지
  않지만 방문객·사장·운영자가 남긴 최신 현장 관측은 출처와 시각을 붙여 UI에 표시한다.
- `/predict/model-info`는 버전, 적재 시각, 실데이터 수, 학습 기간, MAE, 기준선 대비 개선율과
  폴백 상태만 반환하며 Storage 경로는 노출하지 않는다.

## 모델과 피처

| 항목 | 내용 |
|---|---|
| 과제 | 시설 유형별 시간대 혼잡도(0~1) 회귀 |
| 알고리즘 | Ridge Regression (α=1.0) + One-Hot Encoding |
| 피처 스키마 | `congestion-v1:type-hour-dow` |
| 피처 | 시설 유형, UTC 시각(0–23), 요일(0–6) |
| 시설 유형 | restaurant, cafe, attraction, culture |
| 체감 혼잡 매핑 | quiet=0.2, normal=0.5, busy=0.8 |

## 학습 데이터

공식 학습·평가에는 다음만 포함한다.

- `congestion_logs.evidence_tier IN ('verified', 'corroborated')`
- 같은 시설·30분 버킷의 상호확인 보고 중앙값

현장 데이터는 추천 방문 완료의 선택형 혼잡 질문과 일반 장소 제보를 `user_report`로 적재한다.
추천 결과 관측은 DB 트리거가 추천 시설과 조인해 중복 없이 `congestion_logs`로 투영한다. 서로 다른
사용자 2명 이상이 30분 내 같은 수준을 보고하면 `corroborated`로 승격한다. 사장 좌석 방송은
`merchant_report/verified`, 관리자 확인은 `event/verified`로 기록해 즉시 운영 학습에 사용할 수 있다.

`synthetic`, `seed`, `simulated`, `single_report`는 학습과 공식 MAE에서 항상 제외된다. 원시 GPS,
이동 경로와 자유 텍스트는 수집하지 않는다.

## 평가·승격 기준

최근 7일을 고정 홀드아웃으로 두어 시간 순서 누수를 막는다. 기준 모델은 시설 유형·요일·시간대의
학습 구간 평균이며, 없는 버킷은 유형 평균과 전체 평균 순서로 폴백한다.

- 검증 관측 300건 이상
- 활성 시설 유형별 50건 이상
- 최근 7일 홀드아웃 60건 이상이며 각 활성 유형 관측 존재
- 전체 홀드아웃 MAE ≤ 0.15
- 기준 모델 대비 MAE 20% 이상 개선
- 현재 활성 모델 대비 유형별 MAE 악화 ≤ 0.03
- 공식 데이터 구성의 seed/simulated/synthetic/single_report 0건

첫 두 후보는 수동 승인 후 승격한다. 세 번째부터 모든 기준 통과 시 자동 승격하며, 최근 정상 모델
3개만 롤백 대상으로 보관한다.

## 재현 및 운영

```bash
cd apps/api
python scripts/train.py --dry-run
python scripts/train.py
python scripts/train.py --promote-version congestion-YYYYMMDDTHHMMSSZ
python scripts/train.py --rollback-version congestion-YYYYMMDDTHHMMSSZ
curl http://localhost:8000/predict/model-info
```

GitHub Actions `Train Recommendation Model`은 매주 월요일 03:00 KST에 후보를 생성하며 수동 후보,
dry-run, 승격, 롤백 실행도 지원한다.
