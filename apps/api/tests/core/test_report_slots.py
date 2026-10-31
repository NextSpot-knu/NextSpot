"""app/core/report_slots — 혼잡 '1인 1표' 자리 잡기(제보 · 방문 확인 공용)."""
import time

import pytest
from fastapi import HTTPException

from app.core import report_slots
from app.core.report_slots import (
    CORROBORATION_WINDOW_SEC,
    prune_expired,
    release_report_slot,
    reserve_report_slot,
    shared_ip_retry_after,
)


def _age(store: dict, seconds: float) -> None:
    for key, (user_id, at) in list(store.items()):
        store[key] = (user_id, at - seconds)


def test_other_account_on_same_ip_and_place_is_blocked_for_the_whole_window():
    ips: dict = {}
    reserve_report_slot(ip_store=ips, user_id="a", ip="1.2.3.4", facility_id="f")
    with pytest.raises(HTTPException) as blocked:
        reserve_report_slot(ip_store=ips, user_id="b", ip="1.2.3.4", facility_id="f")
    assert blocked.value.status_code == 429
    assert 1790 <= int(blocked.value.headers["Retry-After"]) <= 1800
    # 같은 계정의 재요청 · 다른 장소 · 다른 IP 는 통과한다.
    reserve_report_slot(ip_store=ips, user_id="a", ip="1.2.3.4", facility_id="f")
    reserve_report_slot(ip_store=ips, user_id="b", ip="1.2.3.4", facility_id="g")
    reserve_report_slot(ip_store=ips, user_id="b", ip="5.6.7.8", facility_id="f")
    _age(ips, CORROBORATION_WINDOW_SEC + 1)
    assert shared_ip_retry_after(ips, user_id="b", ip="1.2.3.4", facility_id="f") is None


def test_user_store_is_optional_and_release_restores_previous_state():
    earlier = time.monotonic() - 60.0
    ips: dict = {("1.2.3.4", "f"): ("a", earlier)}
    token = reserve_report_slot(ip_store=ips, user_id="a", ip="1.2.3.4", facility_id="f")
    assert ips[("1.2.3.4", "f")][1] > earlier
    release_report_slot(token)
    assert ips == {("1.2.3.4", "f"): ("a", earlier)}

    users: dict = {}
    token = reserve_report_slot(
        ip_store=ips, user_store=users, user_id="a", ip="9.9.9.9", facility_id="f",
        cooldown_sec=60, cooldown_detail="wait",
    )
    with pytest.raises(HTTPException) as cooled:
        reserve_report_slot(
            ip_store=ips, user_store=users, user_id="a", ip="8.8.8.8", facility_id="f",
            cooldown_sec=60, cooldown_detail="wait",
        )
    assert cooled.value.detail == "wait"
    release_report_slot(token)
    assert users == {}
    assert ("9.9.9.9", "f") not in ips


def test_reports_router_uses_the_core_congestion_vote_table():
    from app.routers import reports

    assert reports._last_report_by_ip is report_slots.CONGESTION_VOTES_BY_IP
    assert reports._last_availability_report_by_ip is not report_slots.CONGESTION_VOTES_BY_IP


def test_expired_entries_holding_raw_ips_are_dropped():
    # 개인정보 안내(privacy.abuseBody): 원본 IP 는 메모리에 약 30분만 머문다 — 창이 지난 키는 지운다.
    now = time.monotonic()
    ips = {("1.2.3.4", "f"): ("a", now - CORROBORATION_WINDOW_SEC - 1), ("5.6.7.8", "f"): ("b", now)}
    prune_expired(ips)
    assert list(ips) == [("5.6.7.8", "f")]
    users = {("a", "f"): now - 400.0, ("b", "f"): now}
    prune_expired(users, max_age=300.0)
    assert list(users) == [("b", "f")]
