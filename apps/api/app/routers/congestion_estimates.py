"""주차 실측 기반 혼잡 **추정치** 적재 — 관리자 수동 트리거.

계약과 산식은 app/services/parking_derived_congestion_service.py 와
docs/CONGESTION_DATA.md §10 에 있다. 여기는 가드·오류 번역만 한다.

⚠️ 자동 주기 실행을 붙이지 않는다. 10분마다 추정치가 쌓이기 시작하면 congestion_logs 의
   다수가 추정치가 되고, 그 뒤에 되돌리려면 어느 행이 언제 들어갔는지 다시 세어야 한다.
   지금은 관리자가 시연 직전에 한 번 누르는 경로만 연다.
"""

import structlog
from fastapi import APIRouter, Depends, HTTPException

from app.core.authz import ROLE_ADMIN, require_role
from app.services.parking_derived_congestion_service import (
    ParkingDerivedError,
    preview_parking_derived_estimates,
    record_parking_derived_estimates,
)

logger = structlog.get_logger()
router = APIRouter(prefix="/api/v1/admin/congestion-estimates", tags=["admin"])

# 서비스 오류 코드 → HTTP 상태. 전부 500 으로 뭉개면 관리자는 '서버 고장' 과 '아직 할 일이
# 남았다'(마이그레이션 미적용)와 '수집이 죽었다'(스냅샷 낡음)를 구분할 수 없다.
_STATUS_BY_CODE = {
    # 사람이 SQL Editor 에 붙여넣어야 할 것이 남아 있다. 서버는 멀쩡하다.
    "migration_not_applied": 409,
    # 원본이 없거나 낡았다 — 이쪽은 주차 수집 파이프라인의 상태 문제다.
    "no_parking_snapshot": 503,
    "no_parking_lots": 503,
    "parking_snapshot_stale": 503,
    "parking_snapshot_in_future": 503,
    "snapshot_timestamp_unparsable": 503,
    "duplicate_check_failed": 503,
}


def _fail(exc: ParkingDerivedError) -> HTTPException:
    return HTTPException(status_code=_STATUS_BY_CODE.get(exc.code, 503), detail=exc.code)


@router.get(
    "/parking-derived/preview",
    dependencies=[Depends(require_role(ROLE_ADMIN))],
)
async def preview_parking_derived():
    """무엇이 적재될지 계산만 한다(쓰기 없음).

    낡은 스냅샷도 거절하지 않고 ``stale: true`` 로 그대로 보여 준다 — 관리자가 확인해야
    하는 것이 바로 그 사실이기 때문이다. 적재(POST)만 막힌다.
    """
    try:
        return await preview_parking_derived_estimates()
    except ParkingDerivedError as exc:
        logger.warning("parking_derived_preview_failed", code=exc.code)
        raise _fail(exc) from exc
    except Exception as exc:
        logger.error("parking_derived_preview_error", error=str(exc))
        raise HTTPException(status_code=503, detail="parking_derived_unavailable") from exc


@router.post(
    "/parking-derived",
    dependencies=[Depends(require_role(ROLE_ADMIN))],
)
async def record_parking_derived():
    """최신 주차 실측에서 시설별 추정치를 만들어 적재한다.

    같은 버킷 시각에 이미 적재돼 있으면 아무것도 넣지 않고 ``status: already_recorded`` 로
    돌려준다 — 두 번 눌러도 같은 관측이 두 배로 쌓이지 않는다.
    """
    try:
        return await record_parking_derived_estimates()
    except ParkingDerivedError as exc:
        logger.warning("parking_derived_record_failed", code=exc.code)
        raise _fail(exc) from exc
    except Exception as exc:
        # 예외 원문은 서버 로그로만 — DB 오류 문자열을 클라이언트에 노출하지 않는다.
        logger.error("parking_derived_record_error", error=str(exc))
        raise HTTPException(status_code=500, detail="parking_derived_record_failed") from exc
