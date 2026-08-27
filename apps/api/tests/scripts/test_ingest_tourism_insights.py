import pytest

from scripts import ingest_tourism_insights as script


@pytest.mark.asyncio
async def test_default_dataset_does_not_call_unapproved_related_api(monkeypatch):
    calls: list[str] = []

    async def concentration(*, dry_run: bool):
        calls.append(f"concentration:{dry_run}")

    async def related(*, dry_run: bool, base_ym: str):
        raise AssertionError("별도 승인 상품을 기본 실행에서 호출하면 안 됩니다")

    monkeypatch.setattr(script, "_ingest_concentration", concentration)
    monkeypatch.setattr(script, "_ingest_related", related)

    assert await script.run(dry_run=True, base_ym="202608") == 0
    assert calls == ["concentration:True"]


@pytest.mark.asyncio
async def test_all_stores_concentration_before_related_failure(monkeypatch):
    calls: list[str] = []

    async def concentration(*, dry_run: bool):
        calls.append("concentration")

    async def related(*, dry_run: bool, base_ym: str):
        calls.append("related")
        raise RuntimeError("not approved")

    monkeypatch.setattr(script, "_ingest_concentration", concentration)
    monkeypatch.setattr(script, "_ingest_related", related)

    with pytest.raises(RuntimeError, match="not approved"):
        await script.run(dry_run=False, base_ym="202608", dataset="all")
    assert calls == ["concentration", "related"]


@pytest.mark.asyncio
async def test_empty_concentration_response_fails_visible(monkeypatch):
    async def empty_payload(*, page: int, rows: int):
        return {"response": {"body": {"items": ""}}}

    monkeypatch.setattr(script, "concentration_forecast", empty_payload)

    with pytest.raises(RuntimeError, match="저장 가능한 전망 행이 없습니다"):
        await script._ingest_concentration(dry_run=True)


@pytest.mark.asyncio
async def test_concentration_loader_follows_total_count_and_deduplicates(monkeypatch):
    monkeypatch.setattr(script, "_CONCENTRATION_PAGE_SIZE", 2)
    calls: list[int] = []

    async def page_payload(*, page: int, rows: int):
        calls.append(page)
        items = {
            1: [
                {"tAtsNm": "대릉원", "baseYmd": "20260824", "cnctrRate": "70"},
                {"tAtsNm": "첨성대", "baseYmd": "20260824", "cnctrRate": "60"},
            ],
            2: [
                # 공급자가 페이지 경계에서 중복을 돌려줘도 DB upsert payload는 하나여야 한다.
                {"tAtsNm": "첨성대", "baseYmd": "20260824", "cnctrRate": "60"},
            ],
        }[page]
        return {
            "response": {
                "body": {"totalCount": 3, "items": {"item": items}}
            }
        }

    monkeypatch.setattr(script, "concentration_forecast", page_payload)

    rows = await script._load_all_concentration_rows()

    assert calls == [1, 2]
    assert [(row["tourist_attraction_name"], row["forecast_date"]) for row in rows] == [
        ("대릉원", "2026-08-24"),
        ("첨성대", "2026-08-24"),
    ]
