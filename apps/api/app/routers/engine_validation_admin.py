"""관리자용 **엔진 검증** 조회 API — 서울 실시간 도시데이터 대비 혼잡 추정기 성적.

`docs/CONGESTION_ENGINE_PLAN.md` §5.3-4·§5.4 A·§6. 수집(`seoul_citydata_snapshots` 적재)은 다른 라우터
(`engine_validation.py`, 기계 호출)가 맡고, 여기는 **읽기만** 한다. 지표 계산은 순수 함수 모듈
(`app/services/engine_validation_metrics.py`)에 있다.

## 응답은 '상태' 를 먼저 말한다

수집은 사람이 인증키를 넣고 마이그레이션을 적용한 뒤에야 시작한다. 그 전후로 이 화면이 만날 수 있는
상황은 서로 다른 사실이고, 관리자가 할 일도 다르다. 그래서 500 이나 빈 배열로 뭉개지 않고 `state` 로 가른다:

    not_migrated  테이블이 없다 — 마이그레이션 20260920120000 을 적용해야 한다
    empty         테이블은 있는데 행이 한 줄도 없다 — 수집 시작 전(키·pg_cron 확인)
    stalled       예전 행은 있는데 조회 창 안에는 없다 — 수집이 멈췄다
    collecting    창 안에 행이 있지만 어느 지표도 최소 표본에 못 미친다
    ready         한 지표 이상 판정할 수 있다(통과·미달 여부와 무관)

테이블 부재는 **200 + not_migrated** 로 준다. 배포 순서(API 먼저·마이그레이션 나중)에 따라 흔히 거치는
정상 단계라 서버 장애(5xx)로 보이면 안 된다. 그 밖의 조회 실패는 503 `engine_validation_unavailable`.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.authz import ROLE_ADMIN, require_role
from app.core.supabase import fetch_all_rows, supabase_admin
from app.services import engine_validation_metrics as metrics
from app.services import seoul_alternatives_service as alternatives

logger = structlog.get_logger()

router = APIRouter(
    prefix="/api/v1/admin/engine-validation",
    tags=["admin"],
    dependencies=[Depends(require_role(ROLE_ADMIN))],
)

TABLE = "seoul_citydata_snapshots"
MIGRATION = "20260920120000_seoul_citydata_snapshots.sql"
# prk(주차장 원문)는 지표에 쓰지 않고 행마다 커서 뺀다. fcst 는 서울시 예측 비교에 쓴다.
_COLUMNS = (
    "id,area_cd,area_nm,bucket_at,observed_at,fetched_at,congest_lvl,ppltn_min,ppltn_max,"
    "fcst,live_lot_count,parking_level,tourism_level,level_est,estimator_version"
)
# 수집 주기가 10분이다. 최신 버킷이 이보다 오래됐으면 수집이 밀리거나 멈춘 것이다.
STALE_AFTER_MINUTES = 30

# 테이블 부재 신호(PostgREST PGRST205 · Postgres 42P01). 컬럼 부재(42703 "column … does not exist")는
# 여기 들지 않는다 — 그건 마이그레이션 미적용이 아니라 스키마 불일치라 다른 조치가 필요하다.
_TABLE_MISSING_SIGNALS = ("pgrst205", "42p01", "could not find the table")


def _is_missing_table(exc: Exception) -> bool:
    text = str(exc).lower()
    if any(signal in text for signal in _TABLE_MISSING_SIGNALS):
        return True
    return "relation" in text and "does not exist" in text and "column" not in text


def _load_window(since_iso: str) -> list[dict[str, Any]]:
    # fetch_all_rows: PostgREST 는 1000행에서 조용히 자른다. 14일 × 144버킷 = 2,016행이라 한 번에 안 온다.
    # 페이지 경계가 흔들리지 않게 (bucket_at, id) 로 전순서를 건다.
    return fetch_all_rows(
        supabase_admin,
        TABLE,
        select=_COLUMNS,
        apply_filters=lambda query: query.gte("bucket_at", since_iso).order("bucket_at").order("id"),
    )


def _load_latest() -> dict[str, Any] | None:
    res = (
        supabase_admin.table(TABLE)
        .select("area_nm,bucket_at,observed_at")
        .order("bucket_at", desc=True)
        .limit(1)
        .execute()
    )
    return res.data[0] if res.data else None


def _collection(rows: list[dict[str, Any]], latest: dict[str, Any] | None, now: datetime) -> dict[str, Any]:
    buckets = [b for b in (metrics.parse_time(row.get("bucket_at")) for row in rows) if b is not None]
    observed = [o for o in (metrics.parse_time(row.get("observed_at")) for row in rows) if o is not None]
    latest_bucket = metrics.parse_time(latest.get("bucket_at")) if latest else None
    age = (now - latest_bucket).total_seconds() / 60.0 if latest_bucket else None
    return {
        "row_count": len(rows),
        "first_bucket_at": min(buckets).isoformat() if buckets else None,
        "last_bucket_at": max(buckets).isoformat() if buckets else None,
        "first_observed_at": min(observed).isoformat() if observed else None,
        "last_observed_at": max(observed).isoformat() if observed else None,
        "hours_collected": round((max(buckets) - min(buckets)).total_seconds() / 3600.0, 2) if buckets else 0.0,
        "latest_bucket_at": latest_bucket.isoformat() if latest_bucket else None,
        "latest_age_minutes": round(age, 1) if age is not None else None,
        "stale": age is not None and age > STALE_AFTER_MINUTES,
        "stale_after_minutes": STALE_AFTER_MINUTES,
    }


def _envelope(state: str, *, days: int, now: datetime, since: datetime) -> dict[str, Any]:
    return {
        "state": state,
        "window_days": days,
        "window_start": since.isoformat(),
        "generated_at": now.isoformat(),
        "table": TABLE,
        "migration": MIGRATION,
        "grade_labels": list(metrics.GRADE_LABELS),
        "estimate_grade_edges": list(metrics.ESTIMATE_GRADE_EDGES),
        "min_samples": metrics.MIN_SAMPLES,
        "min_danger_samples": metrics.MIN_DANGER_SAMPLES,
        "omitted_metrics": list(metrics.OMITTED_METRICS),
        "collection": None,
        "places": [],
    }


def build_summary(days: int, *, now: datetime | None = None) -> dict[str, Any]:
    """동기 본체(테스트가 직접 부른다). 테이블 부재는 not_migrated, 그 외 예외는 그대로 올린다."""
    now = now or datetime.now(timezone.utc)
    since = now - timedelta(days=days)
    try:
        rows = _load_window(since.isoformat())
    except Exception as exc:
        if _is_missing_table(exc):
            logger.info("engine_validation_table_missing", error=str(exc))
            return _envelope("not_migrated", days=days, now=now, since=since)
        raise

    # 창 밖의 최신 행까지 본다 — 창이 비었을 때 '처음부터 없음' 과 '멈췄음' 은 할 일이 다르다.
    latest = _load_latest()
    envelope = _envelope("empty", days=days, now=now, since=since)
    envelope["collection"] = _collection(rows, latest, now)
    if not rows:
        envelope["state"] = "stalled" if latest else "empty"
        return envelope

    places = metrics.summarize(rows)
    envelope["places"] = places
    envelope["state"] = "ready" if any(place["sufficient"] for place in places) else "collecting"
    return envelope


@router.get("/seoul/summary")
async def seoul_summary(days: int = Query(14, ge=1, le=28)):
    """서울 대상지별 검증 지표·혼동표·시계열 + 수집 상태."""
    try:
        return await asyncio.to_thread(build_summary, days)
    except Exception as exc:
        logger.error("engine_validation_summary_failed", error=str(exc))
        raise HTTPException(status_code=503, detail="engine_validation_unavailable") from exc


# ---------------------------------------------------------------------------
# 시연 권역 — 실측 인구로 돌린 대안 추천 (§5.4 A2)
# ---------------------------------------------------------------------------
#
# summary 와 같은 표를 읽지만 **묻는 것이 다르다.** summary 는 "우리 추정이 실측을 맞히나" 이고,
# 여기는 "실시간 인구가 있으면 SPOT 이 어떻게 도나" 다. 그래서 이 응답에는 `level_est` 가 한 번도
#들어가지 않는다 — 섞이면 두 질문이 한 화면에서 뒤섞인다.
#
# 상태는 summary 와 같은 어법이되 이 화면이 답해야 하는 네 가지만 둔다:
#
#     not_migrated  표가 없다
#     empty         시연 권역 3곳의 행이 한 줄도 없다
#     stale         행은 있는데 최신 버킷이 30분보다 오래됐다 — "지금" 이라고 말하면 안 된다
#     ready         30분 안의 실측으로 답할 수 있다

# 대안 추천에 필요한 열만 읽는다. 추정(level_est)·주차 원문은 일부러 뺐다(위 주석).
_ALTERNATIVE_COLUMNS = "area_cd,area_nm,bucket_at,observed_at,congest_lvl,ppltn_min,ppltn_max"
_CLUSTER_NAMES = [place.area_nm for place in alternatives.DEMO_CLUSTER]


def _load_cluster_window(since_iso: str) -> list[dict[str, Any]]:
    return fetch_all_rows(
        supabase_admin,
        TABLE,
        select=_ALTERNATIVE_COLUMNS,
        apply_filters=lambda query: (
            query.in_("area_nm", _CLUSTER_NAMES).gte("bucket_at", since_iso).order("bucket_at").order("area_nm")
        ),
    )


def _load_cluster_latest() -> dict[str, Any] | None:
    """창 밖이라도 가장 최근 행 하나. '한 번도 없음'(empty)과 '멈췄음'(stale)을 가른다."""
    res = (
        supabase_admin.table(TABLE)
        .select("area_nm,bucket_at")
        .in_("area_nm", _CLUSTER_NAMES)
        .order("bucket_at", desc=True)
        .limit(1)
        .execute()
    )
    return res.data[0] if res.data else None


def _alternatives_envelope(state: str, *, origin: str, now: datetime, since: datetime) -> dict[str, Any]:
    return {
        "state": state,
        "generated_at": now.isoformat(),
        "table": TABLE,
        "migration": MIGRATION,
        "origin": origin,
        "default_origin": alternatives.DEFAULT_ORIGIN,
        "cluster": [
            {
                "area_cd": place.area_cd,
                "area_nm": place.area_nm,
                "latitude": place.latitude,
                "longitude": place.longitude,
            }
            for place in alternatives.DEMO_CLUSTER
        ],
        "source": alternatives.SOURCE_MEASURED,
        "source_note": alternatives.MEASURED_CAVEAT,
        "attribution": "서울특별시 서울 실시간 도시데이터 (공공누리 제1유형)",
        "stale_after_minutes": alternatives.STALE_AFTER_MINUTES,
        "lookback_days": alternatives.LOOKBACK_DAYS,
        "lookback_start": since.isoformat(),
        "grade_labels": list(metrics.GRADE_LABELS),
        "grade_levels": dict(alternatives.GRADE_LEVELS),
        "estimate_grade_edges": list(metrics.ESTIMATE_GRADE_EDGES),
        "walking": alternatives.walking_method(),
        "latest_bucket_at": None,
        "latest_age_minutes": None,
        "places": [],
        "ranking": [],
        "recommendation": None,
    }


def build_alternatives(origin: str, *, now: datetime | None = None) -> dict[str, Any]:
    """동기 본체(테스트가 직접 부른다). `origin` 은 이미 검증된 대상지 이름이어야 한다."""
    now = now or datetime.now(timezone.utc)
    since = now - timedelta(days=alternatives.LOOKBACK_DAYS)
    try:
        rows = _load_cluster_window(since.isoformat())
    except Exception as exc:
        if _is_missing_table(exc):
            logger.info("engine_validation_table_missing", error=str(exc))
            return _alternatives_envelope("not_migrated", origin=origin, now=now, since=since)
        raise

    envelope = _alternatives_envelope("empty", origin=origin, now=now, since=since)
    if not rows:
        latest = _load_cluster_latest()
        latest_bucket = metrics.parse_time(latest.get("bucket_at")) if latest else None
        if latest_bucket is not None:
            envelope["state"] = "stale"
            envelope["latest_bucket_at"] = latest_bucket.isoformat()
            envelope["latest_age_minutes"] = round((now - latest_bucket).total_seconds() / 60.0, 1)
        # 행이 없어도 카드 3장은 만든다 — 무엇을 기다리는 중인지가 이 화면의 답이다.
        envelope["places"] = alternatives.build_places([], origin=origin, now=now)
        envelope["recommendation"] = alternatives.build_recommendation(envelope["places"], origin=origin)
        return envelope

    places = alternatives.build_places(rows, origin=origin, now=now)
    envelope["places"] = places
    envelope["recommendation"] = alternatives.build_recommendation(places, origin=origin)
    envelope["ranking"] = [card["area_nm"] for card in sorted(
        (card for card in places if card["rank"] is not None), key=lambda card: card["rank"]
    )]
    ages = [card["age_minutes"] for card in places if card["age_minutes"] is not None]
    buckets = [card["bucket_at"] for card in places if card["bucket_at"]]
    if buckets:
        envelope["latest_bucket_at"] = max(buckets)
        envelope["latest_age_minutes"] = min(ages) if ages else None
    # 가장 싱싱한 버킷마저 30분을 넘었으면 이 화면은 '지금' 을 말할 수 없다.
    envelope["state"] = "stale" if (not ages or min(ages) > alternatives.STALE_AFTER_MINUTES) else "ready"
    return envelope


@router.get("/seoul/alternatives")
async def seoul_alternatives(origin: str | None = Query(None)):
    """시연 권역(홍대·연남동·합정역)의 **실측 인구**로 돌린 대안 추천."""
    resolved = alternatives.resolve_origin(origin)
    if resolved is None:
        # 422: 모르는 출발지를 기본값으로 조용히 바꾸면 화면이 엉뚱한 곳을 '선택됨' 으로 보여 준다.
        raise HTTPException(status_code=422, detail="unknown_origin")
    try:
        return await asyncio.to_thread(build_alternatives, resolved)
    except Exception as exc:
        logger.error("engine_validation_alternatives_failed", error=str(exc))
        raise HTTPException(status_code=503, detail="engine_validation_unavailable") from exc
