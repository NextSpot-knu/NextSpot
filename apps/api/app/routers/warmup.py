"""수동 예열 엔드포인트 — `GET /api/v1/warmup` (무인증).

부팅 예열은 이미 `main.lifespan` 이 한다. 이것은 **그 뒤**를 위한 것이다: Render 무료 인스턴스는
유휴 상태에서 프로세스를 내리고, 공유 캐시들의 TTL(주차·축제·날씨·시설 목록)도 데모 사이에
만료된다. 그래서 심사위원이 첫 화면을 여는 순간이 하필 콜드 경로가 되고, 그 한 번이
`/recommendations/by-type` 20초·`/courses/plan` 43초(실측)로 나타난다.

발표 직전에 이 경로를 한 번 때려 두면 그 비용을 사람이 미리 치른다.

설계 규약(전부 의도적이다):
  · **즉시 돌려준다.** 실제 적재는 백그라운드 태스크이고 응답은 기다리지 않는다(<100ms).
    예열을 응답으로 기다리면 그 요청 자체가 0.5 CPU 를 붙들어 헬스체크를 굶긴다 —
    고치려던 장애를 그대로 일으키는 셈이다.
  · **절대 500 을 내지 않는다.** 단계마다 예외를 삼키고 경고만 남긴다. 예열은 최적화이지
    계약이 아니다(lifespan 워밍업과 같은 판단).
  · **몇 번을 불러도 싸다.** 진행 중이거나 5분 안에 끝난 적이 있으면 아무것도 하지 않는다.
  · 무인증이다. 사용자 데이터를 읽지도 쓰지도 않고, 공유 캐시를 채우기만 한다.
"""

import asyncio
import math
import threading
import time
from datetime import datetime, timezone

import structlog
from fastapi import APIRouter

from app.core.memory_guard import release_memory

logger = structlog.get_logger()
router = APIRouter(prefix="/api/v1", tags=["system"])

# 경주 황리단길 데모 중심(lifespan 워밍업과 같은 좌표 — 같은 캐시 격자를 채워야 한다).
_DEMO_CENTER_LAT = 35.8361
_DEMO_CENTER_LNG = 129.2105

# 재예열 간격. 데모 사이 반복 호출을 흡수하면서도, 발표 시작 전 다시 부르면 실제로 돈다.
_RECENTLY_WARMED_SECONDS = 300.0
# 전체 상한. 넘기면 남은 단계를 포기한다 — 예열 태스크가 인스턴스를 붙들고 있으면 안 된다.
_WARMUP_BUDGET_SECONDS = 45.0
# 지역수요 RPC 예열에 쓸 시설 좌표 상한(중복 격자는 서비스가 알아서 접는다).
# DB 순서 앞 60개가 아니라 **데모 중심에서 가장 가까운** 좌표만 채운다 — 첫 by-type/코스
# 요청이 채점하는 후보는 데모 중심 반경 안이라 그 격자만 채우면 적중률은 오르고 메모리는 준다
# (실측 2026-09-21: 그 60개가 경주 전역에 흩어져 40~57격자·~20-26MB 를 채웠다 → 근접 24개면
# 10~20격자로 준다).
_AREA_DEMAND_PREFETCH_LIMIT = 24

_state_lock = threading.Lock()
_running = False
_last_finished_at: float | None = None
# 태스크를 살려 두는 강한 참조. 놓으면 GC 가 실행 중인 예열을 거둬 갈 수 있다.
_tasks: set[asyncio.Task] = set()


def _claim_warmup() -> bool:
    """이번 호출이 실제로 예열을 돌려야 하면 True. 진행 중·최근 완료면 False."""
    global _running
    with _state_lock:
        if _running:
            return False
        if _last_finished_at is not None and time.monotonic() - _last_finished_at < _RECENTLY_WARMED_SECONDS:
            return False
        _running = True
        return True


def _release_warmup() -> None:
    """예열이 끝났다 — 5분 쿨다운을 건다."""
    global _running, _last_finished_at
    with _state_lock:
        _running = False
        _last_finished_at = time.monotonic()


def _abort_warmup() -> None:
    """예열을 시작조차 못 했다 — 쿨다운을 걸지 않고 플래그만 푼다(다음 호출이 재시도)."""
    global _running
    with _state_lock:
        _running = False


async def _step(name: str, coro) -> None:
    """예열 단계 하나. 무슨 일이 있어도 올리지 않는다(취소는 제외 — 종료 신호다)."""
    started = time.perf_counter()
    try:
        await coro
    except asyncio.CancelledError:
        raise
    except BaseException as exc:  # noqa: BLE001 — 위 모듈 주석: 예열은 계약이 아니다.
        logger.warning("warmup_step_failed", step=name, error_type=type(exc).__name__, error=str(exc))
        return
    logger.info("warmup_step_ready", step=name, elapsed_ms=round((time.perf_counter() - started) * 1000))


def _nearest_coordinates(facilities: list[dict], limit: int) -> list[tuple[float, float]]:
    """시설 목록에서 데모 중심(_DEMO_CENTER_LAT/LNG)과 가장 가까운 좌표 상위 `limit`개.

    순수 함수로 뺀 이유: _warm_all 안에 박아 두면 "가까운 순 정렬"이라는 선택 로직 자체를
    지역수요 서비스·워킹그래프 임포트 없이 단위 테스트할 방법이 없다. 좌표가 없거나(None)
    숫자로 못 바꾸는 행(문자열 쓰레기값 등)은 건너뛴다 — 하버사인 계산이 죽으면 예열 단계
    하나가 그냥 통째로 실패하는 것보다, 그 행 하나만 조용히 빼는 편이 낫다.

    거리 계산까지 try 안에 넣고 isfinite 로 한 번 더 거르는 이유(2026-09-21 리뷰 지적):
    float("1e309") 는 예외 없이 inf 를 돌려주고(Postgres double precision 은 'Infinity' 를
    실제로 저장할 수 있다), calculate_haversine_distance 는 그 값으로 math.sin(inf) 를 불러
    ValueError(math domain error) 를 낸다. 이 함수는 _warm_all 이 gather 를 만들기 **전에**
    동기로 불리므로, 그 한 행 때문에 예열 6단계가 하나도 돌지 않는다. 더 나쁜 건 조용하다는
    것이다 — _run_warmup 이 예외를 삼키고 finally 에서 5분 쿨다운을 걸어 그 뒤 5분간의
    /warmup 은 실제로 아무것도 채우지 않은 채 no-op 이 된다. NaN 은 예외를 내지 않는 대신
    지구 반대편 거리(약 2만 km)로 정렬되는데, 좌표로 넘기면 지역수요 격자가 엉뚱한 곳에
    생기니 같이 버린다.
    """
    from app.services.spot.travel import calculate_haversine_distance

    scored: list[tuple[float, tuple[float, float]]] = []
    for facility in facilities:
        lat, lng = facility.get("latitude"), facility.get("longitude")
        if lat is None or lng is None:
            continue
        try:
            lat, lng = float(lat), float(lng)
            if not (math.isfinite(lat) and math.isfinite(lng)):
                continue
            distance = calculate_haversine_distance(_DEMO_CENTER_LAT, _DEMO_CENTER_LNG, lat, lng)
        except (TypeError, ValueError):
            continue
        scored.append((distance, (lat, lng)))
    scored.sort(key=lambda pair: pair[0])
    return [coord for _, coord in scored[:limit]]


async def _warm_all() -> None:
    """공유 캐시를 채운다. 하나가 실패해도 나머지는 계속한다."""
    # import 를 함수 안에 두는 이유: 이 라우터가 추천·코스 서비스 그래프를 부팅 시점에
    # 통째로 끌고 오지 않게 한다(라우터 등록 순서와 순환 import 위험을 만들지 않는다).
    from app.routers.recommendations import fetch_all_facilities
    from app.services.congestion_evidence import load_current_estimates
    from app.services.area_demand_forecast_service import prefetch_area_demand_points
    from app.services.event_boost import get_event_congestion_boost
    from app.services.parking_demand_service import get_nearby_parking_lots
    from app.services.spot import travel as travel_service
    from app.services.weather_service import get_gyeongju_weather

    now = datetime.now(timezone.utc)

    # 1) 시설 목록(단일 키 'all' 캐시) — 모든 추천·코스 요청의 공통 입구.
    #    영업 근거는 **일부러 받지 않는다**: 캐시되지 않는 값이라(요청마다 다시 받는다)
    #    여기서 받아 봐야 버려지고, 1,600여 곳을 150개씩 끊어 받는 PostgREST 요청 11건만
    #    낭비한다. 시설 캐시를 채우는 효과는 with_availability 와 무관하게 동일하다.
    facilities: list[dict] = []

    async def _load_facilities() -> None:
        nonlocal facilities
        facilities = await fetch_all_facilities(with_availability=False)

    await _step("facilities", _load_facilities())

    # 2) 나머지 상류는 서로 독립이라 함께 돌린다. 하나가 느려도 다른 것을 막지 않는다.
    #    보행 그래프(gzip JSON 언피클)는 CPU 작업이라 워커 스레드로 밀어낸다 —
    #    이벤트 루프에서 돌리면 예열이 헬스체크를 굶기는 자충수가 된다.
    coords = _nearest_coordinates(facilities, _AREA_DEMAND_PREFETCH_LIMIT)
    await asyncio.gather(
        _step("walking_graph", asyncio.to_thread(travel_service._load_graph)),
        _step("estimates", load_current_estimates()),
        _step("parking", get_nearby_parking_lots(_DEMO_CENTER_LAT, _DEMO_CENTER_LNG, radius_m=3_000)),
        _step("festival", get_event_congestion_boost(_DEMO_CENTER_LAT, _DEMO_CENTER_LNG, now)),
        _step("weather", get_gyeongju_weather(now)),
        _step("area_demand", prefetch_area_demand_points(coords, now=now)),
    )


async def _run_warmup() -> None:
    started = time.perf_counter()
    try:
        await asyncio.wait_for(_warm_all(), timeout=_WARMUP_BUDGET_SECONDS)
    except asyncio.CancelledError:
        # 프로세스 종료 신호. 조용히 접는다.
        raise
    except BaseException as exc:  # noqa: BLE001 — 예열 실패가 로그 한 줄보다 커지면 안 된다.
        logger.warning("warmup_run_failed", error_type=type(exc).__name__, error=str(exc))
    finally:
        _release_warmup()
    logger.info("warmup_run_done", total_ms=round((time.perf_counter() - started) * 1000))
    # 예열이 끝날 때마다 RSS 가 계단식으로 쌓이던 것(2026-09-25 실측 270→335MB, 타임아웃 뒤 +55MB)을
    # 끊는다 — 캐시에 남길 것만 남기고 계산 중 쓴 빈 힙은 OS 에 돌려준다(app.core.memory_guard).
    await asyncio.to_thread(release_memory)


@router.get("/warmup")
async def warmup() -> dict:
    """무거운 공유 캐시를 백그라운드로 채우기 시작하고 즉시 돌려준다.

    반환은 언제나 `{"status": "warming"}` 이다 — 이미 돌고 있든, 방금 시작했든, 5분 안에
    끝난 적이 있든 호출자가 할 일은 같다(잠시 뒤에 화면을 열면 된다). 상태를 여러 값으로
    나누면 호출자가 그 값에 분기를 만들게 되는데, 예열은 분기할 만한 사실이 아니다.
    """
    try:
        if _claim_warmup():
            task = asyncio.create_task(_run_warmup(), name="api-warmup")
            _tasks.add(task)
            task.add_done_callback(_tasks.discard)
            logger.info("warmup_scheduled")
    except Exception as exc:  # noqa: BLE001 — 이 엔드포인트는 500 을 내지 않는다.
        logger.warning("warmup_schedule_failed", error_type=type(exc).__name__, error=str(exc))
        # 예약에 실패했으면 쿨다운 없이 플래그만 푼다 — 다음 호출이 곧바로 다시 시도한다.
        _abort_warmup()
    return {"status": "warming"}
