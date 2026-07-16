"""게스트 데이터 승계: 전부 monkeypatch/fake이며 실DB·실네트워크를 사용하지 않는다."""
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.core.supabase import get_current_user
from app.routers import account


class FakeQuery:
    def __init__(self, db, table):
        self.db, self.table_name, self.filters = db, table, []
        self.action, self.values, self.columns = "select", {}, "*"

    def select(self, columns):
        self.columns = columns
        return self

    def update(self, values):
        self.action, self.values = "update", values
        return self

    def delete(self):
        self.action = "delete"
        return self

    def eq(self, column, value):
        self.filters.append(("eq", column, value))
        return self

    def in_(self, column, values):
        self.filters.append(("in", column, values))
        return self

    def execute(self):
        rows = self.db.rows[self.table_name]
        matched = [r for r in rows if all((r[c] == v if op == "eq" else r[c] in v) for op, c, v in self.filters)]
        if self.action == "update":
            for row in matched:
                row.update(self.values)
        elif self.action == "delete":
            self.db.rows[self.table_name] = [r for r in rows if r not in matched]
        if self.action == "select" and self.columns != "*":
            matched = [{key: row[key] for key in self.columns.split(",")} for row in matched]
        return SimpleNamespace(data=[dict(r) for r in matched])


class FakeDB:
    def __init__(self):
        self.rows = {
            "recommendations": [{"id": "r1", "user_id": "guest"}],
            "user_feedback": [{"id": "f1", "recommendation_id": "r1", "user_id": "guest"}],
            "saved_facilities": [
                {"user_id": "guest", "facility_id": "shared"},
                {"user_id": "guest", "facility_id": "guest-only"},
                {"user_id": "target", "facility_id": "shared"},
            ],
        }

    def table(self, name):
        return FakeQuery(self, name)


@pytest.fixture
def client(monkeypatch):
    app = FastAPI()
    app.include_router(account.router)
    app.dependency_overrides[get_current_user] = lambda: {"id": "target"}
    db = FakeDB()
    monkeypatch.setattr(account, "supabase_admin", db)
    monkeypatch.setattr(account, "verify_supabase_token", lambda token: {"sub": token, "is_anonymous": True})
    with TestClient(app) as test_client:
        yield test_client, db


def test_anonymous_token_moves_all_guest_data(client):
    http, db = client
    response = http.post("/api/v1/account/merge-guest", json={"guest_token": "guest"})
    assert response.status_code == 200
    assert response.json() == {"recommendations": 1, "user_feedback": 1, "saved_facilities": 1}
    assert all(row["user_id"] == "target" for row in db.rows["recommendations"] + db.rows["user_feedback"])
    assert sorted(r["facility_id"] for r in db.rows["saved_facilities"]) == ["guest-only", "shared"]


def test_non_anonymous_token_is_forbidden(client, monkeypatch):
    http, _ = client
    monkeypatch.setattr(account, "verify_supabase_token", lambda _: {"sub": "victim", "is_anonymous": False})
    assert http.post("/api/v1/account/merge-guest", json={"guest_token": "real"}).status_code == 403


@pytest.mark.parametrize("detail", ["expired", "forged"])
def test_invalid_guest_token_is_unauthorized(client, monkeypatch, detail):
    http, _ = client
    def reject(_):
        raise HTTPException(status_code=401, detail=detail)
    monkeypatch.setattr(account, "verify_supabase_token", reject)
    assert http.post("/api/v1/account/merge-guest", json={"guest_token": detail}).status_code == 401


def test_same_uid_is_noop(client):
    http, db = client
    before = {name: [dict(row) for row in rows] for name, rows in db.rows.items()}
    response = http.post("/api/v1/account/merge-guest", json={"guest_token": "target"})
    assert response.json() == {"recommendations": 0, "user_feedback": 0, "saved_facilities": 0}
    assert db.rows == before


def test_retry_is_idempotent(client):
    http, _ = client
    assert http.post("/api/v1/account/merge-guest", json={"guest_token": "guest"}).json()["recommendations"] == 1
    assert http.post("/api/v1/account/merge-guest", json={"guest_token": "guest"}).json() == {
        "recommendations": 0, "user_feedback": 0, "saved_facilities": 0,
    }


def test_cannot_steal_real_accounts_data(client, monkeypatch):
    http, db = client
    monkeypatch.setattr(account, "verify_supabase_token", lambda _: {"sub": "victim", "is_anonymous": False})
    before = {name: [dict(row) for row in rows] for name, rows in db.rows.items()}
    assert http.post("/api/v1/account/merge-guest", json={"guest_token": "victim-token"}).status_code == 403
    assert db.rows == before
