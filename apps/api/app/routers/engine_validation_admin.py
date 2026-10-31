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

위 `state` 는 지표(추정기 성적표)의 상태다. 화면 맨 위 '실시간 데이터 리허설'(SEOUL_TESTBED_PLAN §6 S6)은
따로 `pipeline`(대상지별 주기·마지막 버킷·채움률·호출 예산·정규화 표)과 `decision_quality`(S4 전에는
not_evaluated)를 읽는다 — 둘 다 **덧붙인 필드**이고 기존 필드는 그대로다.

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
from app.services import seoul_citydata_service as seoul
from app.services import seoul_collection_status as status_rules
from app.services.crowd import seoul_provider as crowd_seoul
from app.services.crowd import store as crowd_store
from app.core.admin_coalesce import coalesced_admin_view

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
# 예전(모든 대상지 10분 주기) 기준. 지금은 대상지별 주기로 정한다 — `seoul_collection_status.stale_after_minutes`
# (max(30, 2 × 주기 + 8)). 10분 주기에서는 여전히 이 값이다.
STALE_AFTER_MINUTES = status_rules.BASE_STALE_AFTER_MINUTES

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


def _collection(
    rows: list[dict[str, Any]],
    latest: dict[str, Any] | None,
    now: datetime,
    stale_after: int = STALE_AFTER_MINUTES,
) -> dict[str, Any]:
    """표 전체의 수집 요약. `stale` 은 **어느 대상지의 행도** 기준보다 오래됐다는 뜻(수집기 전체가 멈춤)이고,
    기준은 가장 자주 부르는 대상지의 주기로 정한다. 대상지별 판정은 `pipeline.targets` 가 한다."""
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
        "stale": age is not None and age > stale_after,
        "stale_after_minutes": stale_after,
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
        "pipeline": None,
        "decision_quality": dict(DECISION_QUALITY),
    }


# ---------------------------------------------------------------------------
# 실시간 데이터 리허설 — 대상지별 수집 상태 · 정규화 표 · 결정 품질(§6 S6)
# ---------------------------------------------------------------------------
#
# 아래 `pipeline` 블록은 "지금 서울 실시간 파이프라인이 실제로 어떤가" 를 대상지마다 말한다. 지표(places)와 달리
# 표본이 적어도 바로 답할 수 있어야 하므로 summary 의 상태(state)와 무관하게 항상 채운다. 판정 규칙(주기를 아는
# 신선도·채움률 분모·호출 예산)은 `seoul_collection_status` 에 있고, 여기는 DB 를 읽어 넘기기만 한다.

ZONE_TABLE = crowd_store.TABLE
ZONE_MIGRATION = crowd_store.MIGRATION
ZONE_MIGRATION_STEP = (
    f"Supabase SQL Editor 에서 supabase/migrations/{ZONE_MIGRATION} 을 실행하고 "
    "NOTIFY pgrst, 'reload schema'; 로 스키마 캐시를 새로 읽힌다(사람 작업)."
)
ZONE_SEED_STEP = (
    f"zones 표에 이 대상지의 구역 행이 없다 — {ZONE_MIGRATION} 의 시드 행이 적용됐는지, "
    "대상지를 늘렸다면 구역 시드도 함께 넣었는지 확인한다(사람 작업)."
)
SNAPSHOT_MIGRATION_STEP = (
    f"Supabase SQL Editor 에서 supabase/migrations/{MIGRATION} 을 실행하고 "
    "NOTIFY pgrst, 'reload schema'; 를 실행한다(사람 작업)."
)

# 결정 품질(G2 · V3)은 S4 재생 평가가 만든다. 아직 없다 — 숫자 자리를 비워 두지 않고 상태로만 말한다.
DECISION_QUALITY: dict[str, Any] = {
    "state": "not_evaluated",
    "stage": "S4",
    "criterion": (
        "V3 — 추천지가 도착 시 1단계 이상 덜 붐빌 확률이 '가장 가까운 곳' 기준선보다 10%p 이상 높고, "
        "일 블록 부트스트랩 95% 신뢰구간 하한 > 0"
    ),
    "result": None,
}


def _load_target_latest(area_nm: str) -> datetime | None:
    """창 밖이라도 이 대상지의 가장 최근 버킷. '한 번도 없음'(empty)과 '멈춤'(stale)을 가른다."""
    res = (
        supabase_admin.table(TABLE)
        .select("area_nm,bucket_at")
        .eq("area_nm", area_nm)
        .order("bucket_at", desc=True)
        .limit(1)
        .execute()
    )
    return metrics.parse_time(res.data[0].get("bucket_at")) if res.data else None


def _load_target_first(area_nm: str) -> datetime | None:
    """표 전체에서 이 대상지의 첫 버킷 — 창보다 나중에 수집을 시작한 대상지의 채움률 분모를 거기서부터 센다."""
    res = (
        supabase_admin.table(TABLE)
        .select("area_nm,bucket_at")
        .eq("area_nm", area_nm)
        .order("bucket_at")
        .limit(1)
        .execute()
    )
    return metrics.parse_time(res.data[0].get("bucket_at")) if res.data else None


def _load_zone_window(since_iso: str) -> list[dict[str, Any]]:
    # 페이지 경계가 흔들리지 않게 유니크 키(zone_id, source, bucket_at) 전체로 전순서를 건다 — 공급원이 둘이 되면
    # (bucket_at, zone_id) 만으로는 같은 값의 행끼리 순서가 정해지지 않아 페이지 사이에서 겹치거나 빠진다.
    return fetch_all_rows(
        supabase_admin,
        ZONE_TABLE,
        select="zone_id,source,bucket_at",
        apply_filters=lambda query: (
            query.gte("bucket_at", since_iso).order("bucket_at").order("zone_id").order("source")
        ),
    )


def _load_zone_latest() -> dict[str, Any] | None:
    res = (
        supabase_admin.table(ZONE_TABLE)
        .select("zone_id,bucket_at")
        .order("bucket_at", desc=True)
        .limit(1)
        .execute()
    )
    return res.data[0] if res.data else None


def _zones_block(now: datetime, run: dict[str, Any]) -> tuple[dict[str, Any], dict[str, int] | None]:
    """정규화 표(`zone_crowd_snapshots`) 상태와 구역별 24시간 행 수. 이 표의 장애는 summary 를 깨지 않는다.

    두 출처를 함께 준다 — 서로 다른 사실이라서다:
      · table_state — 지금 DB 를 읽어 본 결과(not_migrated · empty · no_recent_rows · has_rows · unavailable)
      · last_write  — 이 프로세스의 마지막 수집이 그 표에 쓴 결과(stored · partial · migration_not_applied ·
                      failed · skipped). 프로세스 메모리라 재시작 뒤 첫 수집 전에는 None 이다.
    """
    last_write = run.get("zone_snapshots") if isinstance(run.get("zone_snapshots"), dict) else None
    block: dict[str, Any] = {
        "table": ZONE_TABLE,
        "migration": ZONE_MIGRATION,
        "table_state": "unavailable",
        "rows_24h": None,
        "latest_bucket_at": None,
        "latest_age_minutes": None,
        "last_write": (
            {
                "state": last_write.get("state"),
                "stored_count": last_write.get("stored_count"),
                "errors": dict(last_write.get("errors") or {}),
                "at": run.get("last_run_at"),
            }
            if last_write
            else None
        ),
        "human_step": None,
    }
    counts: dict[str, int] | None = None
    since = now - timedelta(days=1)
    try:
        rows = _load_zone_window(since.isoformat())
        latest_row = rows[-1] if rows else _load_zone_latest()
    except Exception as exc:  # noqa: BLE001 — 이중 저장 표의 문제로 원본 상태 화면을 막지 않는다
        if crowd_store.is_missing_table(exc, ZONE_TABLE):
            block["table_state"] = "not_migrated"
        else:
            logger.warning("engine_validation_zone_table_unavailable", error_type=type(exc).__name__)
    else:
        counts = {}
        for row in rows:
            zone_id = str(row.get("zone_id") or "")
            counts[zone_id] = counts.get(zone_id, 0) + 1
        latest_bucket = metrics.parse_time(latest_row.get("bucket_at")) if latest_row else None
        block["rows_24h"] = len(rows)
        if latest_bucket is not None:
            block["latest_bucket_at"] = latest_bucket.isoformat()
            block["latest_age_minutes"] = round((now - latest_bucket).total_seconds() / 60.0, 1)
        block["table_state"] = "has_rows" if rows else ("no_recent_rows" if latest_bucket else "empty")
    write_state = (block["last_write"] or {}).get("state")
    write_errors = (block["last_write"] or {}).get("errors") or {}
    if block["table_state"] == "not_migrated" or write_state == "migration_not_applied":
        block["human_step"] = ZONE_MIGRATION_STEP
    elif "zone_not_defined" in write_errors.values():
        block["human_step"] = ZONE_SEED_STEP
    return block, counts


def build_pipeline(
    rows: list[dict[str, Any]],
    *,
    table_missing: bool,
    window_start: datetime,
    now: datetime,
) -> dict[str, Any]:
    """대상지별 수집 상태(주기·최신 버킷·나이·채움률·호출 예산) + 정규화 표 상태."""
    schedule, schedule_error = status_rules.load_schedule()
    names = seoul.configured_targets()
    by_name = {item.area_nm: item for item in schedule or []}
    run = seoul.get_collection_status()

    buckets_by_place: dict[str, list[datetime]] = {}
    for row in rows:
        bucket = metrics.parse_time(row.get("bucket_at"))
        if bucket is not None:
            buckets_by_place.setdefault(metrics.place_key(row), []).append(bucket)
    extra = sorted(name for name in buckets_by_place if name not in names)

    zones, zone_counts = _zones_block(now, run)
    targets: list[dict[str, Any]] = []
    for name in [*names, *extra]:
        buckets = buckets_by_place.get(name, [])
        latest = max(buckets) if buckets else (None if table_missing else _load_target_latest(name))
        # 창 시작 뒤에야 첫 행이 보이면 표 전체의 첫 버킷을 확인한다 — 창 안에서 수집을 시작한 대상지인지,
        # 창 앞부분이 끊겨 있었던 것인지 가른다(앞의 경우만 분모 시작을 늦춘다). 그런 대상지만 조회한다.
        item = by_name.get(name)
        first_ever = None
        if buckets and item is not None:
            lead = timedelta(minutes=status_rules.cadence_minutes(item.every) + status_rules.COLLECTION_OFFSET_MINUTES)
            if min(buckets) > window_start + lead:
                first_ever = _load_target_first(name)
        zone = crowd_seoul.zone_for_name(name)
        zone_id = zone.zone_id if zone else None
        targets.append(
            status_rules.target_status(
                name,
                item=item,
                configured=name in names,
                schedule_valid=schedule_error is None,
                table_missing=table_missing,
                buckets=buckets,
                latest_bucket=latest,
                window_start=window_start,
                now=now,
                last_run=status_rules.last_run_entry(run, name),
                zone_id=zone_id,
                zone_rows_24h=(zone_counts.get(zone_id, 0) if zone_counts is not None and zone_id else None),
                first_bucket_ever=first_ever,
            )
        )

    if schedule_error is not None:
        schedule_state = "invalid_config"
    elif not names:
        schedule_state = "no_targets"
    else:
        schedule_state = "ok"
    return {
        "schedule_state": schedule_state,
        "schedule_error": schedule_error,
        "key_configured": seoul.key_configured(),
        "table_state": "not_migrated" if table_missing else ("has_rows" if rows else "no_rows_in_window"),
        "human_step": SNAPSHOT_MIGRATION_STEP if table_missing else None,
        "stale_rule": {
            "formula": status_rules.STALE_RULE,
            "base_minutes": status_rules.BASE_STALE_AFTER_MINUTES,
            "collection_offset_minutes": status_rules.COLLECTION_OFFSET_MINUTES,
        },
        "bucket_minutes": status_rules.BUCKET_MINUTES,
        "budget": status_rules.call_budget(schedule) if schedule else None,
        "targets": targets,
        "last_run": {
            "state": run.get("state"),
            "last_run_at": run.get("last_run_at"),
            "last_success_at": run.get("last_success_at"),
            "error_code": run.get("error_code"),
            "skipped_targets": list(run.get("skipped_targets") or []),
            # 프로세스 메모리 — 재시작하면 not_run 으로 돌아간다. DB 행(위 targets)과 함께 읽는다.
            "memory_only": True,
        },
        "zones": zones,
    }


def _attach_cadence(places: list[dict[str, Any]], schedule_map: dict[str, Any]) -> None:
    """대상지 요약에 설정 주기를 붙인다 — 최소 표본(버킷 36개)이 몇 시간인지가 주기마다 다르다."""
    for place in places:
        item = schedule_map.get(str(place.get("area_nm") or ""))
        place["cadence_minutes"] = status_rules.cadence_minutes(item.every) if item else None


def build_summary(days: int, *, now: datetime | None = None) -> dict[str, Any]:
    """동기 본체(테스트가 직접 부른다). 테이블 부재는 not_migrated, 그 외 예외는 그대로 올린다."""
    now = now or datetime.now(timezone.utc)
    since = now - timedelta(days=days)
    try:
        rows = _load_window(since.isoformat())
    except Exception as exc:
        if _is_missing_table(exc):
            logger.info("engine_validation_table_missing", error=str(exc))
            envelope = _envelope("not_migrated", days=days, now=now, since=since)
            envelope["pipeline"] = build_pipeline([], table_missing=True, window_start=since, now=now)
            return envelope
        raise

    # 창 밖의 최신 행까지 본다 — 창이 비었을 때 '처음부터 없음' 과 '멈췄음' 은 할 일이 다르다.
    latest = _load_latest()
    schedule, _ = status_rules.load_schedule()
    envelope = _envelope("empty", days=days, now=now, since=since)
    envelope["collection"] = _collection(rows, latest, now, status_rules.fastest_stale_after(schedule))
    envelope["pipeline"] = build_pipeline(rows, table_missing=False, window_start=since, now=now)
    if not rows:
        envelope["state"] = "stalled" if latest else "empty"
        return envelope

    places = metrics.summarize(rows)
    _attach_cadence(places, {item.area_nm: item for item in schedule or []})
    envelope["places"] = places
    envelope["state"] = "ready" if any(place["sufficient"] for place in places) else "collecting"
    return envelope


@router.get("/seoul/summary")
@coalesced_admin_view("admin/engine-validation/seoul/summary")
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
#     stale         행은 있는데 어느 곳의 최신 버킷도 그 대상지의 신선도 기준(주기별 — 10분 30분 · 30분 68분)
#                   안에 없다 — "지금" 이라고 말하면 안 된다
#     ready         한 곳 이상이 기준 안의 실측으로 답할 수 있다

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


def _cluster_stale_after() -> dict[str, int]:
    """시연 권역 대상지별 신선도 기준(분). 설정이 틀리면 빈 dict — 카드는 기본 30분으로 판정한다."""
    by_target = status_rules.stale_after_by_target()
    return {name: by_target[name] for name in _CLUSTER_NAMES if name in by_target}


def _alternatives_envelope(state: str, *, origin: str, now: datetime, since: datetime) -> dict[str, Any]:
    stale_after = _cluster_stale_after()
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
        # 권역 안에서 가장 느슨한 기준(권역은 같은 주기로 잰다 — config 주석). 카드별 값은 places[].stale_after_minutes.
        "stale_after_minutes": max(stale_after.values(), default=alternatives.STALE_AFTER_MINUTES),
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
        envelope["places"] = alternatives.build_places(
            [], origin=origin, now=now, stale_after=_cluster_stale_after()
        )
        envelope["recommendation"] = alternatives.build_recommendation(envelope["places"], origin=origin)
        return envelope

    places = alternatives.build_places(rows, origin=origin, now=now, stale_after=_cluster_stale_after())
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
    # 어느 곳도 자기 주기의 신선도 기준 안에 없으면 이 화면은 '지금' 을 말할 수 없다.
    fresh = any(card["age_minutes"] is not None and not card["stale"] for card in places)
    envelope["state"] = "ready" if fresh else "stale"
    return envelope


@router.get("/seoul/alternatives")
@coalesced_admin_view("admin/engine-validation/seoul/alternatives")
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
