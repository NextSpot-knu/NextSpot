import asyncio
import time
from datetime import datetime, timedelta, timezone

import structlog
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from app.core.supabase import supabase_client
from app.routers.infrastructures import fetch_latest_congestion_for_all
from app.services.predict_service import get_model_info, predict_congestion

logger = structlog.get_logger()

router = APIRouter(tags=["predict"])

class PredictRequest(BaseModel):
    facility_type: str = Field(..., description="Facility type (e.g., restaurant, cafe, attraction, culture)")
    hour: int = Field(..., ge=0, le=23, description="Hour of the day (0-23)")
    day_of_week: int = Field(..., ge=0, le=6, description="Day of the week (0-6, where 0=Monday, 6=Sunday)")

class PredictResponse(BaseModel):
    predicted_congestion: float

@router.post("", response_model=PredictResponse)
def predict_endpoint(req: PredictRequest):
    # 공개 조회용(무인증) 엔드포인트다. 로컬 model.pkl 미학습 시 0.5 폴백이라 비용 부담이 없다.
    # 내부 전용으로 닫으려면 get_current_user 의존성을 추가하면 된다(응답 스키마 불변).
    pred = predict_congestion(req.facility_type, req.hour, req.day_of_week)
    return PredictResponse(predicted_congestion=pred)


class ModelInfoResponse(BaseModel):
    trained: bool
    # train.py --evaluate 가 model.pkl 에 내장한 메트릭(mae·baseline_mae·train_n·holdout_n·
    # holdout_start·evaluated_at·n_rows·r2_train·trained_at). 구버전 model.pkl 이면 None.
    metrics: dict | None = None


@router.get("/model-info", response_model=ModelInfoResponse)
def model_info_endpoint():
    # 공개 조회용(무인증) — 비식별 학습 메타데이터만 노출한다(관리자 대시보드 정확도 배지,
    # docs/MODEL_CARD.md 의 '재현' 절 참조). 평가 수치 생성은 `python scripts/train.py --evaluate`.
    return ModelInfoResponse(**get_model_info())


# --- 배치 예측 (지도 '미래 도착시점 혼잡' 타임슬라이더용) ---

class BatchPredictRequest(BaseModel):
    hours_ahead: int = Field(..., ge=0, le=12, description="몇 시간 뒤 예측인지 (0=지금)")


class BatchPredictionItem(BaseModel):
    facility_id: str
    predicted_congestion: float
    # 현재 실측 로그에 앵커링된 예측인지 여부. 로그가 없는 시설은 False(타입 수준 예측 원값).
    anchored: bool = True


class BatchPredictResponse(BaseModel):
    generated_at: str
    hours_ahead: int
    predictions: list[BatchPredictionItem]


# 60초 인메모리 캐시 — 슬라이더 연타(버스트)로부터 DB 조회·모델 추론을 보호한다.
# 키: hours_ahead, 값: (monotonic 시각, 응답). 단일 프로세스 데모 서버 전제의 모듈 전역 캐시.
_CACHE_TTL_SECONDS = 60.0
_batch_cache: dict[int, tuple[float, BatchPredictResponse]] = {}


def _utcnow() -> datetime:
    # 테스트에서 고정 시각으로 패치할 수 있도록 분리한 현재 시각(UTC) 헬퍼.
    # 모델은 UTC 시각 기준으로 학습됨(score.py 와 동일 관례) — KST 변환 없이 UTC hour/dow 를 쓴다.
    return datetime.now(timezone.utc)


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


async def _fetch_facilities_id_type() -> list[dict]:
    """모든 시설의 (id, type)만 페이지네이션 조회 (infrastructures 라우터와 동일 패턴)."""
    facilities: list[dict] = []
    limit = 1000
    start = 0
    while True:
        query = supabase_client.table("facilities").select("id, type").range(start, start + limit - 1)
        res = await asyncio.to_thread(query.execute)
        if not res.data:
            break
        facilities.extend(res.data)
        if len(res.data) < limit:
            break
        start += limit
    return facilities


@router.post("/batch", response_model=BatchPredictResponse)
async def predict_batch(req: BatchPredictRequest):
    # 단건 /predict 와 동일하게 공개 조회용(무인증) 엔드포인트다(지도는 로그인 없이 열람 가능).
    cached = _batch_cache.get(req.hours_ahead)
    if cached and time.monotonic() - cached[0] < _CACHE_TTL_SECONDS:
        return cached[1]

    now_dt = _utcnow()
    target_dt = now_dt + timedelta(hours=req.hours_ahead)

    try:
        facilities = await _fetch_facilities_id_type()
    except Exception as e:
        # 예외 원문은 서버 로그로만 — DB 오류 문자열을 클라이언트에 노출하지 않는다.
        logger.error("predict_batch_facilities_error", error=str(e))
        raise HTTPException(status_code=500, detail="시설 데이터 조회에 실패했습니다.")

    facility_ids = [f["id"] for f in facilities]
    # 시설별 최신 실측 로그(없는 시설은 맵에서 빠짐 — fetch 내부에서 개별 실패도 흡수됨)
    congestion_map = await fetch_latest_congestion_for_all(facility_ids)

    # 타입 수준 예측은 (타입 × 시점) 조합당 1회만 계산한다(시설 수와 무관하게 최대 타입수×2회 추론).
    # predict_congestion 은 동기 sklearn 추론이므로 이벤트 루프를 막지 않게 워커 스레드로 오프로드.
    base_now: dict[str, float] = {}
    base_target: dict[str, float] = {}
    for ftype in sorted({f["type"] for f in facilities}):
        base_now[ftype] = await asyncio.to_thread(
            predict_congestion, ftype, now_dt.hour, now_dt.weekday()
        )
        base_target[ftype] = await asyncio.to_thread(
            predict_congestion, ftype, target_dt.hour, target_dt.weekday()
        )

    # [앵커링 방식 — 정직한 표기]
    # 모델은 (시설타입, 시각, 요일) 단위로 학습된 '타입 수준' 예측기다(시설별 개별 모델이 아님).
    # 시설별 예측치는 타입 수준의 시간대 곡선을 그 시설의 '현재 실측 혼잡도'에 앵커링해 만든다:
    #   offset_f  = 현재실측_f − predict(타입, 지금 hour, 지금 dow)
    #   pred_f(t) = clamp01( predict(타입, 목표 hour, 목표 dow) + offset_f )
    # 즉 모델이 시간대별 변화 곡선을, 현재 실측이 시설별 개성(수준)을 제공한다.
    # 현재 로그가 없는 시설은 타입 수준 예측 원값을 그대로 쓰고 anchored=False 로 구분 표기한다.
    predictions: list[BatchPredictionItem] = []
    for f in facilities:
        current = congestion_map.get(f["id"])
        if current is not None:
            offset = float(current["level"]) - base_now[f["type"]]
            predictions.append(BatchPredictionItem(
                facility_id=f["id"],
                predicted_congestion=round(_clamp01(base_target[f["type"]] + offset), 4),
                anchored=True,
            ))
        else:
            predictions.append(BatchPredictionItem(
                facility_id=f["id"],
                predicted_congestion=round(_clamp01(base_target[f["type"]]), 4),
                anchored=False,
            ))

    response = BatchPredictResponse(
        generated_at=now_dt.isoformat(),
        hours_ahead=req.hours_ahead,
        predictions=predictions,
    )
    _batch_cache[req.hours_ahead] = (time.monotonic(), response)
    logger.info("predict_batch_returned", hours_ahead=req.hours_ahead, count=len(predictions))
    return response


# --- 하루 예측 (추천 카드 '최적 방문 시각' 24시간 미니 막대용) ---

# 관광객에게 보여줄 시각은 KST(한국 표준시)다. 모델은 UTC 시각 기준으로 학습되어(위 _utcnow 주석 참조)
# batch 와 동일하게 UTC hour/dow 로 추론한다. 따라서 화면용 KST 시(0-23)를 모델용 UTC hour/dow 로 변환한다.
_KST = timezone(timedelta(hours=9))


class DayHour(BaseModel):
    hour: int  # KST 기준 시(0-23)
    congestion: float


class DayPredictResponse(BaseModel):
    facility_type: str
    dow: int  # 예측 대상 요일(KST, 0=월 … 6=일)
    hours: list[DayHour]
    best_hour: int          # 가장 한산한 KST 시(0-23)
    best_congestion: float


def _kst_hour_to_utc(kst_hour: int, kst_dow: int) -> tuple[int, int]:
    """KST(=UTC+9) 시/요일을 모델이 쓰는 UTC hour/dow 로 변환.

    KST hour 가 9 미만이면 UTC 로는 전날(-9h) 이 되어 요일이 하루 당겨진다.
    """
    if kst_hour >= 9:
        return kst_hour - 9, kst_dow
    return kst_hour + 15, (kst_dow - 1) % 7


@router.get("/day", response_model=DayPredictResponse)
async def predict_day(
    facility_type: str = Query(..., alias="facilityType", description="시설 타입 (restaurant/cafe/attraction/culture)"),
    dow: int | None = Query(None, ge=0, le=6, description="요일(KST, 0=월 … 6=일). 생략 시 오늘(KST)."),
):
    # 단건 /predict 와 동일하게 공개 조회용(무인증) 엔드포인트다(추천 카드는 로그인 없이 열람 가능).
    # 로컬 model.pkl 미학습 시 predict_congestion 이 0.5 폴백이라 비용 부담이 없다.
    resolved_dow = dow if dow is not None else _utcnow().astimezone(_KST).weekday()

    hours: list[DayHour] = []
    for kst_hour in range(24):
        utc_hour, utc_dow = _kst_hour_to_utc(kst_hour, resolved_dow)
        # predict_congestion 은 동기 sklearn 추론 — 이벤트 루프를 막지 않게 워커 스레드로 오프로드(batch 와 동일).
        value = await asyncio.to_thread(predict_congestion, facility_type, utc_hour, utc_dow)
        hours.append(DayHour(hour=kst_hour, congestion=round(value, 4)))

    # 가장 한산한 시각(동률이면 이른 시각). min 은 안정 정렬이라 앞선(이른) hour 가 선택된다.
    best = min(hours, key=lambda h: h.congestion)
    logger.info("predict_day_returned", facility_type=facility_type, dow=resolved_dow, best_hour=best.hour)
    return DayPredictResponse(
        facility_type=facility_type,
        dow=resolved_dow,
        hours=hours,
        best_hour=best.hour,
        best_congestion=best.congestion,
    )
