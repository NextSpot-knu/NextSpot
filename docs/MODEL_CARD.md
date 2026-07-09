# MODEL CARD — NextSpot 혼잡 예측 모델

> 심사 대응 3종 중 '예측 백테스트' 산출물. 평가 실행: `python apps/api/scripts/train.py --evaluate`
> 결과 확인: `GET /predict/model-info` · 관리자 대시보드 헤더의 정확도 배지

## 1. 모델 개요

| 항목 | 내용 |
|---|---|
| 과제 | 시설 카테고리별 시간대 혼잡도(0~1) 회귀 예측 |
| 알고리즘 | Ridge Regression (α=1.0) + One-Hot Encoding |
| 피처 | `[시설타입(4종), 시각(0–23), 요일(0–6)]` — 전부 범주형 원-핫 |
| 타깃 | `congestion_logs.congestion_level` (0.0~1.0) |
| 학습 데이터 | Supabase `congestion_logs` × `facilities` 조인 (UTC 타임스탬프 기준) |
| 아티팩트 | `apps/api/model.pkl` — `{model, encoder, metrics}` (git 미추적) |
| 서빙 | `apps/api/app/services/predict_service.py` 로컬 인메모리 추론 (외부 API 없음) |

시설타입은 canonical 4종(restaurant/cafe/attraction/culture)으로 정규화되며, 학습(train.py)과
추론(predict_service.py)이 동일한 정규화 함수를 사용한다(버킷 정합).

## 2. 예측이 쓰이는 곳

1. **SPOT 추천 w2(시간 비용)** — 후보 시설의 '도착 예상 시점' 혼잡도 → 예상 대기시간
   (`score.py`). 이동시간만큼 미래의 hour/dow 로 예측한다.
2. **w3 재배치 기여** — `max(0, 원본혼잡 − 후보 도착시점 예측혼잡)` 의 예측항.
3. **예측 지도 타임슬라이더** — `POST /predict/batch`. 타입 수준 예측 곡선을 시설별 '현재 실측'에
   앵커링: `pred_f(t) = clamp01(predict(타입,t) + (현재실측_f − predict(타입,지금)))`.
   실측 로그가 없는 시설은 `anchored=false` 로 구분 표기한다(정직한 표기 원칙).

## 3. 평가 프로토콜 (백테스트)

`train.py --evaluate` 는 다음을 수행한다:

1. 로그를 **시간순 정렬** 후 앞 80% 학습 / 뒤 20% 홀드아웃 분할 — 미래 데이터가 학습에
   새어 들어가지 않는 time-ordered split (무작위 분할은 시계열에서 과대평가를 낳는다).
2. 학습 구간만으로 인코더·모델을 적합하고 홀드아웃 **MAE**(평균절대오차, 혼잡도 단위 0~1)를 측정.
3. **기준선 비교**: '학습 구간 평균값 상수 예측'의 MAE — 모델 MAE 가 이보다 낮아야 실질 성능.
4. 평가 후 **전체 데이터로 재학습**한 모델을 저장(서빙 모델은 가용 데이터 전부 사용 — 표준 관행).
5. 메트릭(`mae`, `baseline_mae`, `train_n`, `holdout_n`, `holdout_start`, `evaluated_at`)을
   `model.pkl` 에 내장 → `GET /predict/model-info` 와 관리자 배지가 노출.

최소 50행 미만이면 홀드아웃 통계가 무의미해 평가를 생략한다(학습은 수행).

읽는 법: MAE 0.08 = 평균적으로 혼잡도를 ±8%p 이내로 맞춘다는 뜻. 배지의 "예측 오차 ±N%p" 가
이 값이다.

## 4. 한계와 정직한 표기

- **타입 수준 모델**: (타입×시각×요일) 조합당 하나의 예측 — 개별 시설의 고유 패턴(행사·날씨)은
  잡지 못한다. 시설별 편차는 배치 예측의 실측 앵커링이 보정하지만, 앵커 자체가 오래된 로그면
  왜곡될 수 있다.
- **데모 데이터 의존**: 현재 로그의 상당수는 시뮬레이션 시드/`simulate-peak` 생성분이다. 백테스트
  수치는 '이 데이터 분포에서의' 성능이며, 실측 TourAPI/현장 데이터 전환 시 재평가해야 한다.
- **미학습 조합 폴백**: 학습에 없던 (타입, 시각, 요일)은 0.5(중간값)로 폴백하고 `source=default`
  로 로깅한다 — 의미 없는 절편 예측을 신뢰값처럼 반환하지 않는다.
- **백테스트–서빙 인코딩 차이**: 백테스트 MAE 는 `handle_unknown='ignore'` 인코딩 예측을 그대로
  쓰며, 서빙 경로의 완전 미학습 (타입/시각/요일) 조합에 대한 0.5 폴백을 재현하지 않는다. 따라서 드문
  미학습 버킷에서는 배지 MAE 가 실제 서빙 오차보다 약간 낙관적으로 나올 수 있다.
- **holdout 크기**: 로그가 적으면(수백 행) MAE 의 신뢰구간이 넓다. 배지의 '검증 N건'을 함께 볼 것.

## 5. 재현 방법

```bash
cd apps/api
python scripts/train.py --evaluate   # 백테스트 + 전체 재학습 + model.pkl 저장
# ⚠️ 실행 중인 서버는 model.pkl 을 프로세스 수명 동안 1회만 lazy 로드해 캐시한다
#    (predict_service._local_loaded). 재학습 후에는 서버를 재기동해야 새 모델/메트릭이
#    /predict/model-info 와 추천에 반영된다.
curl http://localhost:8000/predict/model-info   # 재기동 후 메트릭 확인
```

윈도우 로컬은 `PYTHONUTF8=1` + Python 3.11 권장 (루트 `docs/HANDOVER.md` 작업 규칙 참조).
