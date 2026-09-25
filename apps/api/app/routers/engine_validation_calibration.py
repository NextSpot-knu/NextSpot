"""관리자용 **보정 곡선** 조회 API — 서울 실측이 경주 추정을 얼마나 고치는가.

`docs/CONGESTION_ENGINE_PLAN.md` §5.3-5·6(결정 D5). 적합·관문은 전부 순수 함수 모듈
(`app/services/congestion_calibration_service.py`)에 있고 여기는 가드·상태 번역만 한다.
**쓰기는 없다** — 곡선은 `seoul_citydata_snapshots` 의 결정적 함수라 읽을 때 적합한다.

## 상태(state)를 먼저 말한다

관리자가 물어보는 것은 "보정이 켜졌나, 안 켜졌으면 무엇이 모자라나" 하나다. 그래서 빈 배열이나
500 으로 뭉개지 않고 네 가지로 가른다:

    not_migrated  seoul_citydata_snapshots 가 없다 — 마이그레이션 20260920120000 적용 대기
    empty         표는 있는데 보정 대상지(명동·동대문)의 주차·인구 쌍이 0건 — 수집 시작 전
    insufficient  쌍은 있는데 관문(3일 · 300버킷 · 홀드아웃 MAE 개선)을 못 넘었다 → 항등 유지
    ready         관문 통과 — 경주 추정에 곡선이 **실제로 걸려 있다**(applied=true)

테이블 부재는 200 + not_migrated 다(배포 순서상 흔히 거치는 정상 단계 — 서버 장애가 아니다).
그 밖의 조회 실패만 503 `calibration_unavailable`.

관문을 못 넘어도 `curve` 는 채워 보낸다. 감추면 "왜 안 켜졌나" 를 화면에서 설명할 수 없다.
"""

from __future__ import annotations

import asyncio

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.authz import ROLE_ADMIN, require_role
from app.services import congestion_calibration_service as calibration
from app.core.admin_cache import cached_admin_view

logger = structlog.get_logger()

router = APIRouter(
    prefix="/api/v1/admin/engine-validation",
    tags=["admin"],
    dependencies=[Depends(require_role(ROLE_ADMIN))],
)


@router.get("/seoul/calibration")
@cached_admin_view("admin/engine-validation/seoul/calibration")
async def seoul_calibration(
    days: int = Query(calibration.DEFAULT_WINDOW_DAYS, ge=1, le=calibration.MAX_WINDOW_DAYS),
):
    """보정 곡선·관문 통과 여부·시간대 모양·경주에 미치는 영향."""
    try:
        return await asyncio.to_thread(calibration.build_report, days)
    except Exception as exc:
        logger.error("engine_validation_calibration_failed", error=str(exc))
        raise HTTPException(status_code=503, detail="calibration_unavailable") from exc
