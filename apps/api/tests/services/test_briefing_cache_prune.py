"""브리핑 캐시가 지난 시간·날짜 버킷을 쌓아 두지 않는다(P0a — 무한 증가 차단).

두 캐시 모두 키에 시각(가게:KST시간 / KST날짜)이 들어 있어 지난 버킷은 다시 읽히지 않는다.
쓸 때 걷어 내지 않으면 프로세스가 사는 내내 쌓인다.
"""
from app.services import briefing_service, merchant_briefing_service


def test_merchant_briefing_cache_keeps_only_the_current_hour(monkeypatch):
    monkeypatch.setattr(merchant_briefing_service, "_cache", {})
    cache = merchant_briefing_service._cache
    cache["f-old:2026-09-27-09"] = (0.0, 1800.0, {"briefing": "x"})
    cache["f-other:2026-09-27-10"] = (0.0, 1800.0, {"briefing": "y"})
    monkeypatch.setattr(merchant_briefing_service, "_cache_key", lambda fid: f"{fid}:2026-09-27-10")

    merchant_briefing_service._cache_set("f-new", {"briefing": "z"})

    assert set(cache) == {"f-other:2026-09-27-10", "f-new:2026-09-27-10"}


def test_admin_briefing_cache_keeps_only_today(monkeypatch):
    monkeypatch.setattr(briefing_service, "_cache", {"2026-09-26": (0.0, 720.0, {"briefing": "x"})})
    monkeypatch.setattr(briefing_service, "_kst_today", lambda: "2026-09-27")

    briefing_service._cache_set({"briefing": "y"})

    assert set(briefing_service._cache) == {"2026-09-27"}
