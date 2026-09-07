# 문의 답변(검토목록 5번) 라우터 테스트 — 관리자 저장 경로 + 문의자 조회 경로.
#
#  · main.py 는 소유 파일 밖(배선은 별도 작업)이라, 사용자용 라우터는 **그 라우터만 얹은
#    로컬 FastAPI 앱**으로 테스트한다(tests/routers/test_impact.py 와 같은 이유·같은 패턴).
#    관리자 PATCH 는 이미 배선된 app.main.app 을 쓴다(admin.router 는 오래전부터 있다).
#  · DB: supabase_admin 을 canned/실패주입 페이크로 패치 — PostgREST 호출이 발생하지 않는다.
#
# 잡으려는 결함:
#   · 답변 본문이 저장되지 않는데 화면이 '전송됨' 으로 읽는 것(reply_saved 계약)
#   · 마이그레이션 미적용 DB 에서 500 이 나 상태 변경까지 같이 죽는 것
#   · '내 문의' 가 남의 문의를 섞어 내려보내는 것(PII 유출)
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.supabase import get_current_user
from app.main import app
from app.routers import inquiries
from tests.conftest import ADMIN_USER_ID
from tests.routers.test_routers import FakeSupabase, _admin_headers

AUTH_USER_ID = "u-1"
INQUIRY_ID = "11111111-1111-4111-8111-111111111111"


# =========================================================================
# 관리자 PATCH — 답변 본문 저장
# =========================================================================

class _RecordingTable:
    """update() 페이로드를 기록하는 최소 페이크.

    `missing_reply_columns=True` 면 payload 에 답변 컬럼이 들어오는 순간 PostgREST 의
    실제 오류 문구로 실패한다(마이그레이션 미적용 DB 재현).
    """

    def __init__(self, store: dict, *, missing_reply_columns: bool):
        self._store = store
        self._missing = missing_reply_columns
        self._payload: dict | None = None

    def update(self, data: dict):
        self._payload = data
        return self

    def __getattr__(self, _name):
        def _chain(*_args, **_kwargs):
            return self

        return _chain

    def execute(self):
        payload = self._payload or {}
        self._store.setdefault("payloads", []).append(dict(payload))
        if self._missing and "reply_body" in payload:
            raise RuntimeError(
                "{'code': 'PGRST204', 'message': \"Could not find the 'reply_body' "
                "column of 'inquiries' in the schema cache\"}"
            )

        class _Result:
            data = [{"id": INQUIRY_ID, "status": payload.get("status"), **payload}]

        return _Result()


class _RecordingSupabase:
    def __init__(self, *, missing_reply_columns: bool = False):
        self.store: dict = {}
        self._missing = missing_reply_columns

    def table(self, _name: str):
        return _RecordingTable(self.store, missing_reply_columns=self._missing)


@pytest.fixture
def admin_client():
    with TestClient(app) as c:
        yield c


def test_reply_body_is_actually_stored(admin_client):
    """답변 본문·시각·작성자가 실제로 UPDATE 페이로드에 실린다.

    이 화면의 원래 결함이 정확히 여기였다: 관리자가 쓴 글이 어디에도 저장되지 않는데
    화면은 '답변이 전송되었습니다' 라고 알렸다.
    """
    fake = _RecordingSupabase()
    with patch("app.routers.admin.supabase_admin", new=fake):
        res = admin_client.patch(
            f"/api/v1/admin/inquiries/{INQUIRY_ID}",
            json={"status": "resolved", "reply_body": "  확인했습니다. 곧 수정됩니다.  "},
            headers=_admin_headers(),
        )

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["reply_saved"] is True
    assert body["reply_unavailable_reason"] is None

    payload = fake.store["payloads"][0]
    assert payload["status"] == "resolved"
    # 앞뒤 공백은 다듬어 저장한다(관리자가 쓴 글 자체는 보존).
    assert payload["reply_body"] == "확인했습니다. 곧 수정됩니다."
    assert payload["replied_at"], "답변 시각이 기록되지 않았다"
    assert payload["replied_by"] == ADMIN_USER_ID, "답한 관리자가 기록되지 않았다"


def test_blank_reply_body_is_not_stored_as_an_answer(admin_client):
    """공백만 있는 본문은 '답변함' 으로 만들지 않는다 — 빈 답변을 저장하면
    문의자 화면에 빈 답변 카드가 뜨고, 그건 답한 것처럼 보이는 가장 나쁜 상태다."""
    fake = _RecordingSupabase()
    with patch("app.routers.admin.supabase_admin", new=fake):
        res = admin_client.patch(
            f"/api/v1/admin/inquiries/{INQUIRY_ID}",
            json={"status": "resolved", "reply_body": "   \n  "},
            headers=_admin_headers(),
        )

    assert res.status_code == 200, res.text
    assert res.json()["reply_saved"] is False
    # '저장 실패' 가 아니라 '저장할 것이 없었다' — 화면이 둘을 구분해야 하므로 이유는 없다.
    assert res.json()["reply_unavailable_reason"] is None
    assert "reply_body" not in fake.store["payloads"][0]


def test_status_only_patch_still_works(admin_client):
    """구 관리자 번들(status 만 보냄)이 새 서버에서 그대로 동작한다.

    Vercel(웹)과 Render(API)는 배포 시점이 다르고 스테이징이 없다 — 옛 번들이 새 서버를
    두드리는 구간이 실제로 존재한다.
    """
    fake = _RecordingSupabase()
    with patch("app.routers.admin.supabase_admin", new=fake):
        res = admin_client.patch(
            f"/api/v1/admin/inquiries/{INQUIRY_ID}",
            json={"status": "in_progress"},
            headers=_admin_headers(),
        )

    assert res.status_code == 200, res.text
    assert res.json()["reply_saved"] is False
    assert fake.store["payloads"][0] == {"status": "in_progress"}


def test_missing_reply_columns_degrades_instead_of_500(admin_client):
    """마이그레이션 적용 **전**에도 서버가 죽지 않는다.

    마이그레이션은 사람이 원격 SQL Editor 에서 적용하므로 백엔드가 먼저 배포되는 순서가
    실제로 가능하다. 그때 상태 변경까지 같이 죽으면 안 되고, 동시에 답변이 저장되지
    않았다는 사실이 조용히 묻혀서도 안 된다.
    """
    fake = _RecordingSupabase(missing_reply_columns=True)
    with patch("app.routers.admin.supabase_admin", new=fake):
        res = admin_client.patch(
            f"/api/v1/admin/inquiries/{INQUIRY_ID}",
            json={"status": "resolved", "reply_body": "답변 본문"},
            headers=_admin_headers(),
        )

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["reply_saved"] is False, "저장되지 않은 답변을 저장됐다고 보고했다"
    assert body["reply_unavailable_reason"] == "schema_missing"
    # 1차 시도(답변 포함) 실패 → 2차 시도(상태만)로 상태 변경은 완료돼야 한다.
    assert fake.store["payloads"][-1] == {"status": "resolved"}


def test_invalid_status_is_rejected(admin_client):
    """status 검증은 그대로다 — 답변 필드가 생겼다고 느슨해지지 않는다."""
    fake = _RecordingSupabase()
    with patch("app.routers.admin.supabase_admin", new=fake):
        res = admin_client.patch(
            f"/api/v1/admin/inquiries/{INQUIRY_ID}",
            json={"status": "closed", "reply_body": "본문"},
            headers=_admin_headers(),
        )
    assert res.status_code == 422
    assert not fake.store.get("payloads"), "검증 실패인데 DB 를 건드렸다"


# =========================================================================
# 문의자 GET /api/v1/inquiries/mine
# =========================================================================

def _make_app() -> FastAPI:
    test_app = FastAPI()
    test_app.include_router(inquiries.router)
    return test_app


@pytest.fixture
def client():
    # 인증 없는 클라이언트(가드 자체를 검증할 때 사용)
    with TestClient(_make_app()) as c:
        yield c


@pytest.fixture
def auth_client():
    test_app = _make_app()
    test_app.dependency_overrides[get_current_user] = lambda: {
        "id": AUTH_USER_ID,
        "email": "tourist@example.com",
        "role": "authenticated",
    }
    with TestClient(test_app) as c:
        yield c


def test_my_inquiries_requires_auth(client):
    """무인증 조회는 401. 이 표에는 사람이 쓴 본문(PII)이 들어 있다."""
    res = client.get("/api/v1/inquiries/mine")
    assert res.status_code == 401


def test_my_inquiries_returns_reply(auth_client):
    rows = [
        {
            "id": INQUIRY_ID,
            "type": "앱 버그",
            "title": "지도가 안 떠요",
            "content": "본문",
            "status": "resolved",
            "created_at": "2026-09-06T01:00:00+00:00",
            "reply_body": "확인 후 수정했습니다.",
            "replied_at": "2026-09-06T04:00:00+00:00",
        }
    ]
    with patch.object(inquiries, "supabase_admin", FakeSupabase({"inquiries": rows})):
        res = auth_client.get("/api/v1/inquiries/mine")

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["replySupported"] is True
    assert len(body["items"]) == 1
    item = body["items"][0]
    assert item["reply_body"] == "확인 후 수정했습니다."
    assert item["replied_at"] == "2026-09-06T04:00:00+00:00"


def test_my_inquiries_never_exposes_identity_fields(auth_client):
    """user_id/user_name/replied_by 는 응답에 실리지 않는다.

    본인 행이라 당장 위험하진 않지만, 화면이 쓰지 않는 신원 필드를 실어 보내는 습관이
    곧 '조회 범위가 넓어졌을 때의 유출' 이 된다. 응답 모양으로 고정해 둔다.
    """
    rows = [
        {
            "id": INQUIRY_ID,
            "user_id": AUTH_USER_ID,
            "user_name": "홍길동",
            "type": "기타",
            "title": "제목",
            "content": "본문",
            "status": "new",
            "created_at": "2026-09-06T01:00:00+00:00",
            "reply_body": None,
            "replied_at": None,
            "replied_by": "admin-uid",
        }
    ]
    with patch.object(inquiries, "supabase_admin", FakeSupabase({"inquiries": rows})):
        res = auth_client.get("/api/v1/inquiries/mine")

    item = res.json()["items"][0]
    for leaked in ("user_id", "user_name", "replied_by"):
        assert leaked not in item, f"응답에 신원 필드가 새어 나왔다: {leaked}"


def test_my_inquiries_reports_legacy_schema(auth_client):
    """답변 컬럼이 없는 DB 에서도 목록은 보이고, '답변 기능 없음' 을 알린다.

    이 구분이 없으면 화면이 "아직 답변이 없어요" 로 그리는데, 그건 **기다리면 온다는
    거짓말**이다 — 답변을 저장할 자리 자체가 없으므로 기다려도 오지 않는다.
    """
    rows = [
        {
            "id": INQUIRY_ID,
            "type": "기타",
            "title": "제목",
            "content": "본문",
            "status": "new",
            "created_at": "2026-09-06T01:00:00+00:00",
        }
    ]

    class _LegacySupabase:
        """답변 컬럼이 든 select 만 42703 으로 실패시킨다."""

        def table(self, _name: str):
            return _LegacyTable(rows)

    class _LegacyTable:
        def __init__(self, data):
            self._data = data
            self._failed = False

        def select(self, columns: str):
            self._failed = "reply_body" in columns
            return self

        def __getattr__(self, _name):
            def _chain(*_args, **_kwargs):
                return self

            return _chain

        def execute(self):
            if self._failed:
                raise RuntimeError(
                    '{"code":"42703","message":"column inquiries.reply_body does not exist"}'
                )

            class _Result:
                data = rows

            return _Result()

    with patch.object(inquiries, "supabase_admin", _LegacySupabase()):
        res = auth_client.get("/api/v1/inquiries/mine")

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["replySupported"] is False, "답변 컬럼이 없는데 '답변 지원' 이라고 말했다"
    assert len(body["items"]) == 1, "폴백 경로에서 목록이 사라졌다"
    assert body["items"][0]["reply_body"] is None


def test_my_inquiries_fetch_failure_is_not_an_empty_list(auth_client):
    """조회 실패를 빈 목록으로 뭉개지 않는다 — 사용자는 자기 문의가 사라진 줄 안다."""

    class _BrokenSupabase:
        def table(self, _name: str):
            raise RuntimeError("connection reset by peer")

    with patch.object(inquiries, "supabase_admin", _BrokenSupabase()):
        res = auth_client.get("/api/v1/inquiries/mine")

    assert res.status_code == 500
