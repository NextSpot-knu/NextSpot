"""Short-lived, corroborated opening-status evidence for recommendation eligibility."""

import asyncio
from datetime import datetime, timezone

import structlog

from app.core.supabase import fetch_all_rows, supabase_admin

logger = structlog.get_logger()


def _parse_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed


def is_effective_availability_evidence(
    evidence: dict | None,
    *,
    at: datetime | None = None,
) -> bool:
    """Only fresh, two-user corroborated evidence may affect recommendations."""
    if not evidence or evidence.get("evidence_tier") != "corroborated":
        return False
    if evidence.get("status") not in {"open", "closed"}:
        return False
    if int(evidence.get("corroborating_count") or 0) < 2:
        return False
    expires_at = _parse_timestamp(evidence.get("expires_at"))
    if expires_at is None:
        return False
    current = at or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    return expires_at > current


# PostgREST 의 in.(...) 필터는 id 를 전부 URL 쿼리에 싣는다. UUID 하나가 구분자 포함 ~39바이트라
# 시설 전체(현재 1,600곳+)를 한 번에 넣으면 URL 이 60KB 를 넘어, Supabase 앞단 Cloudflare 가
# 520(Web server is returning an unknown error)을 낼 때까지 ~9초를 잡아먹는다. 그러면 아래
# except 가 조용히 {} 를 돌려주므로 **영업 근거가 항상 비어 있는 채로 정상처럼 보였다**
# (게다가 이 9초가 /courses/recommend 를 프런트 10초 타임아웃 밖으로 밀어내 분산코스가 통째로
#  실패하고 있었다). 그래서 한 요청에 담는 id 수를 제한하고 조각들을 동시에 던진다.
# 150개 ≈ 5.9KB — 흔한 URL 상한(8KB)에 여유 있게 들어간다.
_AVAILABILITY_ID_CHUNK = 150


async def _fetch_availability_chunk(chunk: list[str], now: datetime) -> list[dict]:
    """id 조각 하나에 대한 조회. 실패는 이 조각만 비우고 나머지 조각을 살린다."""
    try:
        result = await asyncio.to_thread(
            supabase_admin.table("facility_availability_reports")
            .select(
                "facility_id,status,evidence_tier,corroborating_count,reported_at,expires_at"
            )
            .in_("facility_id", chunk)
            .eq("evidence_tier", "corroborated")
            .gt("expires_at", now.isoformat())
            .order("reported_at", desc=True)
            .execute
        )
    except Exception as exc:
        # Migration-first deployment is preferred, but an unavailable evidence table must not
        # take the whole recommendation service down.
        logger.warning("availability_evidence_unavailable", error=str(exc), chunk_size=len(chunk))
        return []
    return result.data or []


_AVAILABILITY_COLUMNS = "facility_id,status,evidence_tier,corroborating_count,reported_at,expires_at"


async def _fetch_all_effective_reports(now: datetime, requested: int) -> list[dict]:
    """id 목록 없이 만료 전 corroborated 근거 전부(표가 작다 — 참조 스냅샷이 이미 같은 모양으로 읽는다).

    페이지를 넘겨 받으므로 행수 캡이 없고, (reported_at 내림차순, id) 전순서라 페이지 경계도 고정된다.
    실패하면 이번 호출의 근거가 통째로 빈다(조각 방식에서는 실패한 조각만 비었다 — 상류가 같아 실제로는 함께
    실패한다). 경고는 오늘과 같은 availability_evidence_unavailable.
    """
    try:
        return await asyncio.to_thread(
            fetch_all_rows,
            supabase_admin,
            "facility_availability_reports",
            _AVAILABILITY_COLUMNS,
            apply_filters=lambda q: q.eq("evidence_tier", "corroborated")
            .gt("expires_at", now.isoformat())
            .order("reported_at", desc=True)
            .order("id"),
        )
    except Exception as exc:
        logger.warning("availability_evidence_unavailable", error=str(exc), chunk_size=requested)
        return []


async def fetch_effective_availability_map(facility_ids: list[str]) -> dict[str, dict]:
    """Fetch the newest unexpired corroborated report per facility."""
    unique_ids = list(dict.fromkeys(str(fid) for fid in facility_ids if fid))
    if not unique_ids:
        return {}
    now = datetime.now(timezone.utc)
    chunks = [
        unique_ids[i:i + _AVAILABILITY_ID_CHUNK]
        for i in range(0, len(unique_ids), _AVAILABILITY_ID_CHUNK)
    ]
    if len(chunks) > 1:
        # 조각이 둘 이상이면(메인 추천 3 · by-type 5 · 부팅 프리필 12) 동시 요청 여러 개 대신 id 목록 없이 한 번
        # 받고, 요청 id 의 시설만 고른다 — PostgREST 동시 요청·스레드가 호출마다 2~11개 준다(503 이력의 커넥션
        # 압력). 시설별 첫 유효 행(reported_at 최신)이 이기는 선택은 아래 루프 그대로다. 같은 마이크로초에 보고된
        # 두 근거의 순서만 id 로 고정된다(오늘은 정해지지 않았다). 조각 하나(코스 후보 풀)는 오늘 경로 그대로.
        requested = set(unique_ids)
        results = [[
            row for row in await _fetch_all_effective_reports(now, len(unique_ids))
            if str(row.get("facility_id") or "") in requested
        ]]
    else:
        results = await asyncio.gather(*[_fetch_availability_chunk(c, now) for c in chunks])

    evidence_by_id: dict[str, dict] = {}
    # 조각별로 reported_at 내림차순이므로, 시설별 첫 유효 행이 곧 최신 행이다
    # (같은 시설의 행은 in_ 필터 특성상 한 조각 안에만 존재한다).
    for rows in results:
        for row in rows:
            facility_id = str(row.get("facility_id") or "")
            if facility_id and facility_id not in evidence_by_id and is_effective_availability_evidence(
                row, at=now
            ):
                evidence_by_id[facility_id] = row
    return evidence_by_id


def attach_availability_evidence(
    facilities: list[dict], evidence_by_id: dict[str, dict]
) -> list[dict]:
    """Return isolated facility dictionaries with optional evidence attached."""
    return [
        {
            **facility,
            "availability_evidence": evidence_by_id.get(str(facility.get("id"))),
        }
        for facility in facilities
    ]
