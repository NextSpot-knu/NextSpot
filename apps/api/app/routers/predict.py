import asyncio
import time
from datetime import datetime, timedelta, timezone

import structlog
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.core.supabase import supabase_client
from app.routers.infrastructures import fetch_latest_congestion_for_all
from app.services.predict_service import predict_congestion

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
