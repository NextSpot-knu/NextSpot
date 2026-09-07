"""10분 지역 수요 스냅샷 수집의 운영 신뢰도를 실측 행으로만 계산한다."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any

from app.core.supabase import fetch_all_rows, supabase_admin

BUCKET_MINUTES = 10

# 수집이 죽었다고 단정하는 기준.
#
# 왜 별도 기준이 필요한가: pg_cron 은 net.http_post 로 **발사 후 잊는다.** API 가 401 을 주든
# 500 을 주든 cron.job_run_details 에는 succeeded 로 남는다. 그래서 '스케줄러가 돌았는가' 는
# 수집이 살아 있다는 증거가 못 된다 — 유일하게 믿을 수 있는 신호는 **새 스냅샷이 실제로
# 쌓였는가** 이고, 그건 원인이 무엇이든(토큰 불일치·Render 다운·cron 해제·Supabase 정지)
# 똑같이 잡아낸다.
#
# 3버킷(30분)을 연달아 놓치면 우연이 아니다 — 재시도 cron 이 :06/:16/… 에 한 번 더 두드리므로
# 일시적 실패는 다음 버킷에서 메워진다.
_ALERT_DOWN_AFTER_MINUTES = 35
# 창 전체에서 이 비율을 넘게 빠지면 '간헐 실패' 다. 지금은 살아 있어도 사람이 봐야 한다.
_ALERT_DEGRADED_MISSING_RATE = 0.2
_BUCKET_SECONDS = BUCKET_MINUTES * 60
_FRESH_MINUTES = 30
_DELAYED_MINUTES = 60
_ALLOWED_SOURCES = {"gyeongju_its", "national_parking_api"}

# 응답에 원문 ISO 로 싣는 누락 버킷의 최대 개수.
#
# 왜 자르나: hours 상한 168 이면 창은 1008 버킷이고, **완전 장애 시 그 1008개가 전부 누락**이
# 된다. 그때 목록을 통째로 실으면 응답 대부분이 같은 사실을 1008번 반복하는 ISO 문자열이
# 된다 — 사람도 기계도 앞 몇 개만 보고 판단한다(경보 워크플로는 alert.state 만 읽는다).
#
# 왜 자른 사실을 반드시 함께 싣나: 조용히 20개만 주면 화면에는 '20개만 빠졌다' 는
# **실재하지 않는 그림**이 뜬다. 이 화면의 존재 이유가 정확히 그 판정이므로, 자를 때는
# missing_total/missing_range/missing_truncated 로 '무엇이 잘렸는지' 를 같이 말한다.
# (missing_truncated 와 missing_total 은 자르지 않았을 때도 항상 보낸다 — 있다가 없다가 하는
#  필드는 소비처가 KeyError 로 깨지거나, 없음을 '거짓' 으로 오독하게 만든다.)
_MISSING_BUCKET_SAMPLE_LIMIT = 20


class AreaDemandReliabilityError(RuntimeError):
    """신뢰도 계산에 필요한 운영 테이블을 안전하게 조회하지 못했다."""


def _parse_timestamp(value: Any) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise AreaDemandReliabilityError("invalid_snapshot_timestamp") from exc
    else:
        raise AreaDemandReliabilityError("invalid_snapshot_timestamp")
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise AreaDemandReliabilityError("invalid_snapshot_timestamp")
    return parsed.astimezone(timezone.utc)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat()


def _floor_to_bucket(value: datetime) -> datetime:
    timestamp = int(value.astimezone(timezone.utc).timestamp())
    return datetime.fromtimestamp(timestamp // _BUCKET_SECONDS * _BUCKET_SECONDS, tz=timezone.utc)


def _query_window(source: str, start_at: datetime, end_at: datetime) -> list[dict[str, Any]]:
    """창 안의 버킷 행을 **전량** 받는다 — 페이지네이션이 필수다.

    예전에는 ``.limit(1008)`` 한 번으로 받았다. 그런데 PostgREST 는 단일 응답 행수를
    캡(기본 1000)하므로 limit 을 크게 걸어도 1000행에서 잘린다. 엔드포인트가 허용하는
    hours 상한 168 은 expected_count = 168 × 6 = **1008** 이고, area_demand_snapshots 는
    (source, bucket_at) UNIQUE 라 실제로 1008행이 다 존재할 수 있다. 그러면 8행이 조용히
    잘리고 _missing_metrics 가 그 8개를 '누락 버킷' 으로 만든다 — 잘린 구간이 창 끝에
    몰리므로 관리자 화면에 **실재하지 않는 80분 공백**이 뜨고, 수집이 멀쩡한데 사람이
    장애를 조사하게 된다. 신뢰도 화면의 존재 이유가 정확히 이 판정이므로 캡을 넘겨서는
    안 된다.

    ``.range()`` 는 정렬이 없으면 페이지 경계가 흔들려 행이 중복·누락될 수 있으므로
    order 도 필터 콜백에 함께 넣는다.
    """
    return fetch_all_rows(
        supabase_admin,
        "area_demand_snapshots",
        "id,bucket_at",
        1000,
        lambda query: (
            query.eq("source", source)
            .eq("bucket_minutes", BUCKET_MINUTES)
            .gte("bucket_at", _iso(start_at))
            .lt("bucket_at", _iso(end_at))
            .order("bucket_at")
        ),
    )


def _query_boundary(source: str, *, latest: bool) -> dict[str, Any] | None:
    fields = (
        "id,source,observed_at,bucket_at,total_spaces,available_spaces,"
        "occupancy,live_lot_count"
        if latest
        else "id,bucket_at"
    )
    result = (
        supabase_admin.table("area_demand_snapshots")
        .select(fields)
        .eq("source", source)
        .eq("bucket_minutes", BUCKET_MINUTES)
        .order("bucket_at", desc=latest)
        .limit(1)
        .execute()
    )
    return result.data[0] if result.data else None


def _query_lots(snapshot_id: str) -> list[dict[str, Any]]:
    result = (
        supabase_admin.table("area_demand_snapshot_lots")
        .select(
            "source_lot_id,name,latitude,longitude,total_spaces,"
            "available_spaces,occupancy"
        )
        .eq("snapshot_id", snapshot_id)
        .order("name")
        .limit(500)
        .execute()
    )
    return result.data or []


def _freshness(observed_at: datetime, now: datetime) -> tuple[float, str]:
    age_minutes = (now - observed_at).total_seconds() / 60
    if age_minutes < -5:
        return round(age_minutes, 1), "future_timestamp"
    age_minutes = max(0.0, age_minutes)
    if age_minutes <= _FRESH_MINUTES:
        state = "fresh"
    elif age_minutes <= _DELAYED_MINUTES:
        state = "delayed"
    else:
        state = "stale"
    return round(age_minutes, 1), state


def _missing_metrics(
    *, start_at: datetime, expected_count: int, received: set[datetime]
) -> tuple[list[str], int]:
    missing: list[str] = []
    longest_gap = 0
    current_gap = 0
    for offset in range(expected_count):
        bucket = start_at + timedelta(minutes=BUCKET_MINUTES * offset)
        if bucket in received:
            current_gap = 0
            continue
        missing.append(_iso(bucket))
        current_gap += 1
        longest_gap = max(longest_gap, current_gap)
    return missing, longest_gap


ALERT_OK = "ok"
ALERT_DEGRADED = "degraded"
ALERT_DOWN = "down"
ALERT_UNKNOWN = "unknown"


def _alert(
    *,
    latest_payload: dict[str, Any] | None,
    missing_rate: float,
    history_state: str,
) -> dict[str, Any]:
    """수집이 지금 살아 있는가에 대한 단일 판정.

    reason 은 기계가 읽는 코드다. 사람이 읽을 문장을 여기서 만들지 않는 이유: 이 값을 쓰는
    곳이 관리자 화면과 스케줄러 둘이고, 문장을 여기 박아 두면 로케일이 갈린다.
    """
    if latest_payload is None:
        # 표가 비어 있는 것과 수집이 죽은 것은 다르다. 갓 배포한 환경에서 경보를 울리면
        # 사람이 경보를 끄는 법부터 배운다.
        return {
            "state": ALERT_UNKNOWN if history_state == "no_data" else ALERT_DOWN,
            "reason": "no_snapshot",
            "age_minutes": None,
        }
    age = latest_payload["age_minutes"]
    if age > _ALERT_DOWN_AFTER_MINUTES:
        return {"state": ALERT_DOWN, "reason": "stale_snapshot", "age_minutes": age}
    if missing_rate > _ALERT_DEGRADED_MISSING_RATE:
        return {"state": ALERT_DEGRADED, "reason": "missing_buckets", "age_minutes": age}
    return {"state": ALERT_OK, "reason": None, "age_minutes": age}


async def get_area_demand_reliability(
    *,
    source: str = "gyeongju_its",
    hours: int = 24,
    now: datetime | None = None,
) -> dict[str, Any]:
    """완료된 10분 버킷의 누락과 최신 실측 상태를 service role로 집계한다."""
    if source not in _ALLOWED_SOURCES or not 1 <= hours <= 168:
        raise ValueError("invalid_reliability_window")
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    # 진행 중 버킷은 아직 스케줄 실행 전일 수 있으므로 누락 판정에서 제외한다.
    end_at = _floor_to_bucket(current)
    start_at = end_at - timedelta(hours=hours)
    expected_count = hours * (60 // BUCKET_MINUTES)

    try:
        window_rows, earliest, latest = await asyncio.gather(
            asyncio.to_thread(_query_window, source, start_at, end_at),
            asyncio.to_thread(_query_boundary, source, latest=False),
            asyncio.to_thread(_query_boundary, source, latest=True),
        )
    except AreaDemandReliabilityError:
        raise
    except Exception as exc:
        raise AreaDemandReliabilityError("snapshot_query_failed") from exc

    received: set[datetime] = set()
    for row in window_rows:
        bucket = _parse_timestamp(row.get("bucket_at"))
        if start_at <= bucket < end_at:
            received.add(bucket)
    missing, longest_gap = _missing_metrics(
        start_at=start_at,
        expected_count=expected_count,
        received=received,
    )

    earliest_bucket = _parse_timestamp(earliest["bucket_at"]) if earliest else None
    if latest is None:
        history_state = "no_data"
    elif earliest_bucket is None or earliest_bucket > start_at:
        history_state = "insufficient_history"
    else:
        history_state = "sufficient_history"

    latest_payload = None
    lots: list[dict[str, Any]] = []
    if latest is not None:
        try:
            observed_at = _parse_timestamp(latest.get("observed_at"))
            bucket_at = _parse_timestamp(latest.get("bucket_at"))
            occupancy = float(latest["occupancy"])
            age_minutes, freshness_state = _freshness(observed_at, current)
            latest_payload = {
                "snapshot_id": str(latest["id"]),
                "observed_at": _iso(observed_at),
                "bucket_at": _iso(bucket_at),
                "age_minutes": age_minutes,
                "freshness_state": freshness_state,
                "live_lot_count": int(latest["live_lot_count"]),
                "total_spaces": int(latest["total_spaces"]),
                "available_spaces": int(latest["available_spaces"]),
                "occupancy": occupancy,
            }
            lots = await asyncio.to_thread(_query_lots, str(latest["id"]))
            lots = [
                {
                    "source_lot_id": str(row["source_lot_id"]),
                    "name": str(row["name"]),
                    "latitude": float(row["latitude"]),
                    "longitude": float(row["longitude"]),
                    "total_spaces": int(row["total_spaces"]),
                    "available_spaces": int(row["available_spaces"]),
                    "occupancy": float(row["occupancy"]),
                }
                for row in lots
            ]
            latest_payload["lot_detail_count"] = len(lots)
            latest_payload["lot_details_complete"] = (
                len(lots) == latest_payload["live_lot_count"]
            )
        except AreaDemandReliabilityError:
            raise
        except Exception as exc:
            raise AreaDemandReliabilityError("snapshot_query_failed") from exc

    received_count = len(received)
    missing_count = len(missing)
    missing_rate = round(missing_count / expected_count, 4)
    # 목록은 앞에서부터 자르고(누락은 시간순이라 앞이 곧 '언제부터'), 잘린 사실과 전체 범위를
    # 함께 남긴다. missing_range 는 **자르기 전 전체 목록**의 첫·마지막이라 잘라도 실제 공백
    # 구간의 폭을 그대로 말해 준다.
    missing_sample = missing[:_MISSING_BUCKET_SAMPLE_LIMIT]
    missing_range = (
        {"first_bucket_at": missing[0], "last_bucket_at": missing[-1]} if missing else None
    )
    return {
        "source": source,
        # 여러 지표를 조합해야 알 수 있던 '지금 괜찮은가' 를 한 필드로 답한다.
        # 사람이 대시보드를 안 보는 시간에도 기계가 이 값만 보고 경보할 수 있어야 한다.
        "alert": _alert(
            latest_payload=latest_payload,
            missing_rate=missing_rate,
            history_state=history_state,
        ),
        "history_state": history_state,
        "first_bucket_at": _iso(earliest_bucket) if earliest_bucket else None,
        "window": {
            "hours": hours,
            "bucket_minutes": BUCKET_MINUTES,
            "start_at": _iso(start_at),
            "end_at": _iso(end_at),
            "end_exclusive": True,
            "expected_bucket_count": expected_count,
            "received_bucket_count": received_count,
            "missing_bucket_count": missing_count,
            "missing_rate": missing_rate,
            # 원문 목록은 최대 _MISSING_BUCKET_SAMPLE_LIMIT 개 — 아래 세 필드가 나머지를 설명한다.
            "missing_buckets": missing_sample,
            "missing_total": missing_count,
            "missing_range": missing_range,
            "missing_truncated": missing_count > len(missing_sample),
            "longest_gap_buckets": longest_gap,
            "longest_gap_minutes": longest_gap * BUCKET_MINUTES,
            "complete": missing_count == 0,
        },
        "latest": latest_payload,
        "lots": lots,
    }
