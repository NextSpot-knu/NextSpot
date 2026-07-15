import asyncio
import time
from datetime import datetime, timedelta, timezone

import structlog
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from app.core.supabase import supabase_client
from app.routers.infrastructures import fetch_active_facilities, fetch_latest_congestion_for_all
from app.services.event_boost import get_event_congestion_boost
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
    # 행사 혼잡 보정(A4) — 목표 시점에 진행 중인 인근 축제로 인한 가중치. 없으면 0(투명성 표기).
    event_boost: float = 0.0


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
    """모든 시설의 (id, type, 좌표)만 페이지네이션 조회.

    좌표는 행사 혼잡 보정(A4)의 축제 거리 계산용 — 좌표 없는 행은 보정 없이 동작한다.
    is_active=false(폐업·표출중단 감지, 2차 기획 1위)는 예측 대상에서 제외 —
    infrastructures.fetch_active_facilities 재사용(컬럼 미배포 시 필터 없이 폴백).
    """
    return await fetch_active_facilities(supabase_client, "id, type, latitude, longitude")


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
        # 행사 혼잡 보정(A4): 목표 시점에 진행 중인 인근 축제의 거리 감쇠 가중.
        # 최초 1회만 TourAPI 를 조회(서비스 내부 캐시)하고 이후는 순수 거리 계산이라
        # 시설 수만큼 순차 await 해도 비용이 없다. 좌표 없는 행(구 시드 등)은 보정 생략.
        boost = 0.0
        if f.get("latitude") is not None and f.get("longitude") is not None:
            boost, _ = await get_event_congestion_boost(f["latitude"], f["longitude"], target_dt)

        current = congestion_map.get(f["id"])
        if current is not None:
            offset = float(current["level"]) - base_now[f["type"]]
            predictions.append(BatchPredictionItem(
                facility_id=f["id"],
                predicted_congestion=round(_clamp01(base_target[f["type"]] + offset + boost), 4),
                anchored=True,
                event_boost=boost,
            ))
        else:
            predictions.append(BatchPredictionItem(
                facility_id=f["id"],
                predicted_congestion=round(_clamp01(base_target[f["type"]] + boost), 4),
                anchored=False,
                event_boost=boost,
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


# --- 골든타임 알리미 (오늘 남은 시간대 최저 혼잡 60분 창) ---

class GoldenHourPoint(BaseModel):
    hour: int  # KST 기준 시(0-23)
    congestion: float


class GoldenHourResponse(BaseModel):
    # 프런트는 available=False 면 배지를 렌더하지 않는다(정직한 폴백 — 지어낸 골든타임 금지).
    available: bool
    facility_id: str | None = None
    start: int | None = None       # 최저 혼잡 60분 창의 시작 시(KST, 0-23)
    end: int | None = None         # start+1 (1시간 격자라 60분 창 = 다음 시)
    congestion: float | None = None
    curve: list[GoldenHourPoint] = []


@router.get("/golden-hour", response_model=GoldenHourResponse)
async def predict_golden_hour(
    facility_id: str = Query(..., alias="facilityId", description="시설 UUID"),
):
    """오늘 남은 시간대(현재시각 KST ~ 22시, 1시간 격자)의 예측 혼잡 곡선에서 최저 혼잡 60분 창을 찾는다.

    /predict/day 와 동일하게 KST↔UTC 변환 후 predict_congestion 을 재사용하고, /predict/batch 와
    동일한 앵커링(현재 실측 혼잡 - 지금 시점 타입수준예측 = offset)으로 시설 개성을 반영한다.
    모델이 미학습이면(get_model_info().trained=False) 모든 시각이 0.5 로 평탄해 '골든타임'이
    의미가 없으므로, 그 평탄 곡선을 그럴듯하게 보여주는 대신 available=False 로 정직하게 폴백한다.
    """
    # 1) 시설 존재 확인 + 타입 조회(단건 .limit(1) — admin.py 의 단건 조회 패턴과 동일).
    try:
        res = await asyncio.to_thread(
            supabase_client.table("facilities").select("id, type").eq("id", facility_id).limit(1).execute
        )
    except Exception as e:
        # 예외 원문은 서버 로그로만 — DB 오류 문자열을 클라이언트에 노출하지 않는다.
        logger.error("golden_hour_facility_fetch_error", facility_id=facility_id, error=str(e))
        raise HTTPException(status_code=500, detail="시설 데이터 조회에 실패했습니다.")

    if not res.data:
        raise HTTPException(status_code=404, detail="해당 시설을 찾을 수 없습니다.")

    facility_type = res.data[0]["type"]

    # 2) 모델 미학습 — 정직한 폴백(200 + available:false).
    if not get_model_info()["trained"]:
        logger.info("golden_hour_unavailable_untrained", facility_id=facility_id)
        return GoldenHourResponse(available=False, facility_id=facility_id)

    now_kst = _utcnow().astimezone(_KST)
    current_hour = now_kst.hour
    hours_grid = list(range(current_hour, 23))  # 현재시각 ~ 22시(포함), 1시간 격자

    if not hours_grid:
        # 22시 이후(23시)엔 오늘 남은 시간대가 없다 — 지어내지 않고 정직한 폴백.
        logger.info("golden_hour_unavailable_no_hours_left", facility_id=facility_id, current_hour=current_hour)
        return GoldenHourResponse(available=False, facility_id=facility_id)

    # 3) 앵커링: 이 시설의 현재 실측 혼잡이 있으면 타입 수준 곡선에 오프셋으로 고정(batch 와 동일 공식).
    #    로그가 없으면 오프셋 0(타입 수준 예측 원값 그대로) — anchored 플래그는 골든타임 응답 계약에
    #    없으므로(간결한 스펙) 별도 노출하지 않는다.
    congestion_map = await fetch_latest_congestion_for_all([facility_id])
    current_log = congestion_map.get(facility_id)
    now_utc_hour, now_utc_dow = _kst_hour_to_utc(current_hour, now_kst.weekday())
    base_now = await asyncio.to_thread(predict_congestion, facility_type, now_utc_hour, now_utc_dow)
    offset = (float(current_log["level"]) - base_now) if current_log is not None else 0.0

    curve: list[GoldenHourPoint] = []
    for kst_hour in hours_grid:
        utc_hour, utc_dow = _kst_hour_to_utc(kst_hour, now_kst.weekday())
        value = await asyncio.to_thread(predict_congestion, facility_type, utc_hour, utc_dow)
        curve.append(GoldenHourPoint(hour=kst_hour, congestion=round(_clamp01(value + offset), 4)))

    # 최저 혼잡 시각(동률이면 이른 시각 — min 은 안정 정렬).
    best = min(curve, key=lambda p: p.congestion)
    logger.info("golden_hour_returned", facility_id=facility_id, best_hour=best.hour)
    return GoldenHourResponse(
        available=True,
        facility_id=facility_id,
        start=best.hour,
        end=best.hour + 1,
        congestion=best.congestion,
        curve=curve,
    )
