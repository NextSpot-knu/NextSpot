"""관광공사 Tmap 연관 목적지 데이터를 추천 후보의 맥락 prior로 연결한다."""

from __future__ import annotations

import asyncio
import time
from typing import Any

from app.core.supabase import supabase_admin
from app.services.tourapi.insights import normalized_related_rows

_CACHE_TTL_SECONDS = 60 * 60.0
_cache: tuple[float, list[dict[str, Any]]] | None = None
_lock = asyncio.Lock()


def _name(value: Any) -> str:
    return "".join(str(value or "").split()).casefold()


async def _load_rows() -> list[dict[str, Any]]:
    global _cache
    now = time.monotonic()
    if _cache and now - _cache[0] < _CACHE_TTL_SECONDS:
        return _cache[1]
    async with _lock:
        now = time.monotonic()
        if _cache and now - _cache[0] < _CACHE_TTL_SECONDS:
            return _cache[1]
        try:
            result = await asyncio.to_thread(
                lambda: supabase_admin.table("tourism_insight_snapshots")
                .select("payload,reference_period,fetched_at")
                .eq("insight_type", "related_attraction")
                .order("reference_period", desc=True)
                .limit(1)
                .execute()
            )
        except Exception:
            rows: list[dict[str, Any]] = []
        else:
            payload = result.data[0].get("payload") if result.data else None
            if not isinstance(payload, dict):
                rows = []
            elif isinstance(payload.get("normalized_items"), list):
                rows = [row for row in payload["normalized_items"] if isinstance(row, dict)]
            else:
                rows = normalized_related_rows({
                    "response": {"body": {"items": {"item": payload.get("items", [])}}}
                })
        _cache = (now, rows)
        return rows


async def attach_related_destination_priors(
    original: dict[str, Any], candidates: list[dict[str, Any]]
) -> None:
    """원본과 정확히 연결된 후보에만 순위 기반 prior를 붙인다. 미승인 환경은 무해하다."""
    origin_name = _name(original.get("name"))
    if not origin_name:
        return
    rows = await _load_rows()
    ranks: dict[str, int] = {}
    categories: dict[str, str | None] = {}
    for row in rows:
        if _name(row.get("origin_name")) != origin_name:
            continue
        related_name = _name(row.get("related_name"))
        try:
            rank = int(row.get("related_rank"))
        except (TypeError, ValueError):
            continue
        if not related_name or rank < 1:
            continue
        if related_name not in ranks or rank < ranks[related_name]:
            ranks[related_name] = rank
            categories[related_name] = row.get("related_category")
    for candidate in candidates:
        rank = ranks.get(_name(candidate.get("name")))
        if rank is None:
            continue
        candidate["tourapi_related_rank"] = rank
        candidate["tourapi_related_category"] = categories.get(_name(candidate.get("name")))
        candidate["tourapi_related_prior"] = round(max(0.0, 1.0 - (rank - 1) / 49.0), 4)
