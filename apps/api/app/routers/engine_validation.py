"""혼잡 엔진 **검증** 수집 API — 서울 실시간 도시데이터(OA-21285).

`docs/CONGESTION_ENGINE_PLAN.md` §5.3-1. 수집(쓰기)과 상태만 여기 둔다. 지표 조회(읽기 화면)는
`engine_validation_admin.py`(`/api/v1/admin/engine-validation`)가 맡는다.

오류는 **사람이 할 일**로 갈라 준다 — 500 한 가지로 뭉개면 관리자는 '서버 고장' 으로 읽는다:

    503 seoul_key_missing      Render 에 SEOUL_OPENDATA_KEY 를 넣어야 한다
    503 seoul_targets_missing  SEOUL_CITYDATA_TARGETS 가 비었다
    409 migration_not_applied  20260920120000 마이그레이션을 적용해야 한다(+ NOTIFY pgrst)
    503 <대상지 오류 코드>     모든 대상지가 실패했다(예: seoul_key_invalid · seoul_area_mismatch)

일부 대상지만 실패하면 200 + ``state='partial'`` 이고 실패 사유는 대상지별로 남는다.
응답·로그 어디에도 인증키나 서울 API URL(키가 경로에 들어 있다)을 싣지 않는다.
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.core.authz import ROLE_ADMIN, require_machine_or_role, require_role
from app.services import seoul_citydata_service as seoul
from app.services.seoul_citydata_service import (
    SeoulCitydataError,
    SeoulSnapshotPersistenceError,
)

router = APIRouter(prefix="/api/v1/engine-validation", tags=["engine-validation"])


class SeoulTargetResult(BaseModel):
    area_nm: str
    state: Literal["stored", "failed"]
    error_code: str | None = None
    upstream_code: str | None = None
    area_cd: str | None = None
    bucket_at: str | None = None
    observed_at: str | None = None
    congest_lvl: str | None = None
    live_lot_count: int | None = None
    stale_lot_count: int | None = None
    parking_level: float | None = None
    tourism_level: float | None = None
    level_est: float | None = None


class SeoulCollectResponse(BaseModel):
    state: Literal["ok", "partial"]
    run_at: str
    bucket_at: str
    estimator_version: str
    stored_count: int
    failed_count: int
    targets: list[SeoulTargetResult]


class SeoulStatusResponse(BaseModel):
    kind: Literal["seoul_citydata_validation"] = "seoul_citydata_validation"
    # 키 **존재 여부만**. 값·길이·앞자리 어떤 것도 내보내지 않는다.
    key_configured: bool
    targets: list[str]
    estimator_version: str
    last_run: dict[str, Any]
    latest: dict[str, dict[str, Any] | None]


@router.post(
    "/seoul/collect",
    response_model=SeoulCollectResponse,
    # 주 호출자는 pg_cron(20260920121000, 10분마다)이다 — 세션이 없으니 기계 토큰을 받는다.
    # 경주 수집기(area-demand/snapshots/collect)와 같은 가드: RBAC 전환 때 require_role 만 남겨
    # 수집이 401 로 조용히 죽었던 전례가 있다.
    dependencies=[Depends(require_machine_or_role(ROLE_ADMIN))],
)
async def collect_seoul() -> SeoulCollectResponse:
    """설정된 서울 대상지를 한 번씩 조회해 10분 버킷으로 저장한다(같은 버킷 재호출은 덮어쓰기)."""
    try:
        result = await seoul.collect_seoul_citydata()
    except SeoulSnapshotPersistenceError as exc:
        raise HTTPException(status_code=409, detail=exc.code) from None
    except SeoulCitydataError as exc:
        raise HTTPException(status_code=503, detail=exc.code) from None
    if result["state"] == "failed":
        # 전부 실패 — pg_cron 은 응답을 보지 않지만 net._http_response 에 남는 상태 코드는 정직해야 한다.
        raise HTTPException(status_code=503, detail=result["targets"][0]["error_code"] or "seoul_collect_failed")
    return SeoulCollectResponse(**result)


@router.get(
    "/seoul/status",
    response_model=SeoulStatusResponse,
    dependencies=[Depends(require_role(ROLE_ADMIN))],
)
async def seoul_status() -> SeoulStatusResponse:
    """마지막 수집 결과(프로세스 메모리)와 대상지별 DB 최신 행."""
    targets = seoul.configured_targets()
    try:
        latest = await seoul.latest_rows(targets)
    except SeoulSnapshotPersistenceError as exc:
        status_code = 409 if exc.code == "migration_not_applied" else 503
        raise HTTPException(status_code=status_code, detail=exc.code) from None
    return SeoulStatusResponse(
        key_configured=seoul.key_configured(),
        targets=targets,
        estimator_version=seoul.ESTIMATOR_VERSION,
        last_run=seoul.get_collection_status(),
        latest=latest,
    )
