"""심사용 관리자 계정(openapi@gmail.com) 가드 — 전체 설정 저장·장소 삭제만 막고 쿠폰 슬라이더는 그대로 둔다.

심사위원 여러 명이 같은 계정으로 실서비스를 본다. 한 명이 점검 공지를 켜거나 장소를 지우면 뒤에 오는
심사위원 모두가 바뀐 화면을 보고, 되돌릴 화면도 없다. 쿠폰 정책 슬라이더(PATCH /admin/facilities/{id})는
기능설명서 F5 ⑤ 시연 경로라 열어 둔다. 판정은 인증된 토큰의 이메일로 한다(역할 가드는 그대로 먼저 돈다).
"""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

import jwt
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from tests.conftest import ADMIN_USER_ID, admin_headers

from app.core.authz import JUDGE_ADMIN_EMAIL, is_judge_admin
from app.core.config import settings
from app.routers import admin

SETTINGS_DETAIL = "심사용 계정에서는 전체 설정을 바꿀 수 없어요."
DELETE_DETAIL = "심사용 계정에서는 장소를 삭제할 수 없어요."

SETTINGS_BODY = {
    "maintenance_mode": True,
    "notice_text": "점검 중",
    "congestion_threshold": 70,
    "coldstart_weight": 50,
}
_FACILITY = {"id": "f-1", "name": "이풍녀 구로쌈밥", "type": "restaurant", "coupon_rate": 0.15}
_SETTINGS_ROW = {"id": 1, **SETTINGS_BODY}


class _SpyTable:
    """쓰기 호출(update/delete)을 기록하고, 체이닝은 흡수하고, canned 행을 돌려준다."""

    def __init__(self, name: str, rows: list, calls: list):
        self._name = name
        self._rows = rows
        self._calls = calls

    def update(self, payload):
        self._calls.append((self._name, "update", payload))
        return self

    def delete(self):
        self._calls.append((self._name, "delete"))
        return self

    def __getattr__(self, _name):
        def _chain(*_a, **_k):
            return self
        return _chain

    def execute(self):
        return SimpleNamespace(data=self._rows)


class _SpySupabase:
    def __init__(self, tables: dict):
        self._tables = tables
        self.calls: list = []

    def table(self, name: str) -> _SpyTable:
        return _SpyTable(name, self._tables.get(name, []), self.calls)


def _headers(email: str | None, sub: str = ADMIN_USER_ID) -> dict:
    """conftest 의 admin_headers 와 같은 HS256 토큰에 email 클레임만 더한다(역할은 sub 로 정해진다)."""
    claims = {
        "sub": sub,
        "aud": "authenticated",
        "role": "authenticated",
        "exp": datetime.now(timezone.utc) + timedelta(hours=1),
    }
    if email is not None:
        claims["email"] = email
    return {"Authorization": f"Bearer {jwt.encode(claims, settings.JWT_SECRET, algorithm='HS256')}"}


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(admin.router)
    with TestClient(app) as c:
        yield c


@pytest.fixture
def db():
    spy = _SpySupabase({"facilities": [_FACILITY], "system_settings": [_SETTINGS_ROW]})
    with patch.object(admin, "supabase_admin", new=spy):
        yield spy


def _writes(spy: _SpySupabase) -> list:
    return [c for c in spy.calls if c[1] in ("update", "delete")]


# --- 막는 것: 전체 설정 저장 · 장소 삭제 -------------------------------------------------

def test_judge_admin_cannot_save_global_settings(client, db):
    res = client.put("/api/v1/admin/settings", headers=_headers(JUDGE_ADMIN_EMAIL), json=SETTINGS_BODY)
    assert res.status_code == 403
    assert res.json()["detail"] == SETTINGS_DETAIL
    assert _writes(db) == []  # DB 에 닿기 전에 끊긴다


def test_judge_admin_cannot_delete_facility(client, db):
    res = client.delete("/api/v1/admin/facilities/f-1", headers=_headers(JUDGE_ADMIN_EMAIL))
    assert res.status_code == 403
    assert res.json()["detail"] == DELETE_DETAIL
    assert _writes(db) == []


def test_judge_email_match_ignores_case_and_spaces(client, db):
    res = client.put("/api/v1/admin/settings", headers=_headers("  OpenAPI@Gmail.com "), json=SETTINGS_BODY)
    assert res.status_code == 403
    assert res.json()["detail"] == SETTINGS_DETAIL
    assert _writes(db) == []


# --- 열어 두는 것: 쿠폰 슬라이더 · 읽기 ------------------------------------------------------

def test_judge_admin_can_still_move_coupon_slider(client, db):
    res = client.patch(
        "/api/v1/admin/facilities/f-1", headers=_headers(JUDGE_ADMIN_EMAIL), json={"coupon_rate": 0.2}
    )
    assert res.status_code == 200
    assert _writes(db) == [("facilities", "update", {"coupon_rate": 0.2})]


def test_judge_admin_can_still_read_settings(client, db):
    res = client.get("/api/v1/admin/settings", headers=_headers(JUDGE_ADMIN_EMAIL))
    assert res.status_code == 200
    assert res.json()["id"] == 1


# --- 다른 관리자는 그대로 ---------------------------------------------------------------------

def test_other_admin_can_save_settings_and_delete(client, db):
    headers = _headers("ops@example.com")
    assert client.put("/api/v1/admin/settings", headers=headers, json=SETTINGS_BODY).status_code == 200
    assert client.delete("/api/v1/admin/facilities/f-1", headers=headers).status_code == 200
    assert [c[:2] for c in _writes(db)] == [("system_settings", "update"), ("facilities", "delete")]


def test_admin_token_without_email_is_not_the_judge(client, db):
    # 기존 테스트 토큰(admin_headers)에는 email 클레임이 없다 — 그 경로의 동작은 바뀌지 않는다.
    assert client.put("/api/v1/admin/settings", headers=admin_headers(), json=SETTINGS_BODY).status_code == 200
    assert client.delete("/api/v1/admin/facilities/f-1", headers=admin_headers()).status_code == 200


def test_role_guard_still_runs_first(client, db):
    # 관리자가 아닌 계정은 이메일과 무관하게 기존 역할 거부 문구를 받는다(가드 순서 회귀 방지).
    res = client.put(
        "/api/v1/admin/settings",
        headers=_headers(JUDGE_ADMIN_EMAIL, sub="tttttttt-0000-4000-8000-00000000tou1"),
        json=SETTINGS_BODY,
    )
    assert res.status_code == 403
    assert res.json()["detail"] == "이 기능에 접근할 권한이 없습니다."
    assert _writes(db) == []


def test_is_judge_admin_matches_only_the_judge_email():
    assert is_judge_admin({"email": "openapi@gmail.com"}) is True
    assert is_judge_admin({"email": "OPENAPI@GMAIL.COM"}) is True
    # 사업자 심사 계정·다른 주소·이메일 없음은 해당하지 않는다.
    assert is_judge_admin({"email": "openapi@naver.com"}) is False
    assert is_judge_admin({"email": "openapi@gmail.com.evil.test"}) is False
    assert is_judge_admin({"email": None}) is False
    assert is_judge_admin({}) is False
