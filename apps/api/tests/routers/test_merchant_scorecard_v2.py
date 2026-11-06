# 사장님 성적표 v2(P1-2) — "사장님이 믿고 읽을 수 있는 숫자" 계약을 잠근다.
#
#   · 노출 = 손님 화면에 추천 카드가 실제로 그려진 횟수(usage_events 'rec_shown', props.rank 가 있는 것만).
#     /main 이 미리 받아 두는 4업종×8곳 추천 행은 노출이 아니다. 카드 기록을 못 읽으면 행 수로 물러서되
#     exposure_basis='list_rows' 로 다른 숫자임을 알린다.
#   · 카드 기록은 2026-10-24 에야 생겼다 — 기록 시작이 기간 안이면 counted_since 를 주고, 직전 기간이 기록
#     시작보다 앞서면 비교값을 주지 않는다(없던 기록을 0 으로 읽은 '늘었다' 는 거짓 비교다).
#   · 도착 확인 = recommendation_outcomes.arrival_confirmed_at ⋈ recommendations(이 가게).
#   · 길안내 시작은 예전 수락 행(새 행 삽입)과 새 수락(노출 행 갱신)을 모두 세고, (손님, KST 날짜)당 한 번이다.
#   · 내부 계정(admin·developer)은 쿠폰·제보·길안내·도착에서 빠진다.
#   · 최근 N일(7·30)과 직전 N일을 같은 규칙으로 센다.
#
# 공용 FakeTable 은 필터를 흉내 내지 않아 '서버에 어떤 조건을 보냈는가' 를 검증할 수 없다. 여기서는 필터·
# JSON 경로(props->>x)·select 별칭·정렬·1,000행 캡을 흉내 내는 작은 가짜를 쓴다 — 조건 하나를 빠뜨리면
# 다른 가게·다른 이벤트 행이 섞여 들어와 테스트가 깨진다.
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core import authz
from app.routers import merchant

FAC = "11111111-1111-1111-1111-111111111111"
OTHER = "22222222-2222-2222-2222-222222222222"
ADMIN_ID = "aaaaaaaa-0000-0000-0000-000000000001"
DEV_ID = "aaaaaaaa-0000-0000-0000-000000000002"


# ---------------------------------------------------------------------------
# PostgREST 를 흉내 내는 가짜(필요한 만큼만)
# ---------------------------------------------------------------------------


def _parse_ts(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _read(row: dict, path: str):
    """칼럼 경로를 PostgREST 처럼 읽는다 — a->>b(텍스트) · a->b(JSON) · a.b(끼워 온 행의 칸)."""
    if "->>" in path:
        column, key = path.split("->>", 1)
        value = (row.get(column) or {}).get(key)
        return None if value is None else str(value)
    if "->" in path:
        column, key = path.split("->", 1)
        return (row.get(column) or {}).get(key)
    if "." in path:
        embed, key = path.split(".", 1)
        return (row.get(embed) or {}).get(key)
    return row.get(path)


def _comparable(value):
    ts = _parse_ts(value)
    return ts if ts is not None else value


def _split_select(select: str) -> list[str]:
    parts, depth, current = [], 0, ""
    for ch in select:
        if ch == "," and depth == 0:
            parts.append(current.strip())
            current = ""
            continue
        depth += ch == "("
        depth -= ch == ")"
        current += ch
    if current.strip():
        parts.append(current.strip())
    return parts


class _Res:
    def __init__(self, data):
        self.data = data


class _Query:
    CAP = 1000  # PostgREST 단일 응답 상한 — 넘으면 조용히 잘린다(공용 FakeTable 과 같은 규칙).

    def __init__(self, db: "_Db", table: str):
        self._db, self._table = db, table
        self._select = "*"
        self._filters: list = []
        self._order: list = []
        self._limit = None
        self._range = None

    def select(self, columns="*", **_kwargs):
        self._select = columns
        return self

    def _add(self, fn):
        self._filters.append(fn)
        return self

    def eq(self, col, value):
        return self._add(lambda r: _read(r, col) == value)

    def neq(self, col, value):
        # SQL 의미 그대로 — NULL <> 'x' 는 참이 아니다.
        return self._add(lambda r: _read(r, col) is not None and _read(r, col) != value)

    def gte(self, col, value):
        return self._add(lambda r: _read(r, col) is not None and _comparable(_read(r, col)) >= _comparable(value))

    def lt(self, col, value):
        return self._add(lambda r: _read(r, col) is not None and _comparable(_read(r, col)) < _comparable(value))

    def in_(self, col, values):
        return self._add(lambda r: _read(r, col) in values)

    def order(self, col, desc=False):
        self._order.append((col, desc))
        return self

    def limit(self, n):
        self._limit = n
        return self

    def range(self, start, end):
        self._range = (start, end)
        return self

    def _project(self, row: dict) -> dict:
        if self._select.strip() == "*":
            return dict(row)
        out = {}
        for item in _split_select(self._select):
            alias, _, expr = item.partition(":") if ":" in item else ("", "", item)
            if "(" in expr:  # 끼워 오기 — recommendations!inner(...) 는 행에 미리 넣어 둔 객체를 그대로 준다.
                name = expr.split("(", 1)[0].split("!", 1)[0]
                out[alias or name] = row.get(name)
                continue
            out[alias or expr] = _read(row, expr)
        return out

    def execute(self):
        if self._table in self._db.failing:
            raise RuntimeError(f'relation "{self._table}" is unavailable')
        self._db.calls.append(self._table)
        rows = [r for r in self._db.tables.get(self._table, []) if all(f(r) for f in self._filters)]
        for col, desc in reversed(self._order):
            present = [r for r in rows if _read(r, col) is not None]
            missing = [r for r in rows if _read(r, col) is None]
            rows = sorted(present, key=lambda r: _comparable(_read(r, col)), reverse=desc) + missing
        if self._range is not None:
            rows = rows[self._range[0] : self._range[1] + 1]
        if self._limit is not None:
            rows = rows[: self._limit]
        return _Res([self._project(r) for r in rows[: self.CAP]])


class _Db:
    def __init__(self, tables: dict, failing: frozenset = frozenset()):
        self.tables = {"system_settings": [{"id": 1, "merchant_console_enabled": True}], **tables}
        self.failing = failing
        self.calls: list[str] = []

    def table(self, name: str) -> _Query:
        return _Query(self, name)


# ---------------------------------------------------------------------------
# 앱 · 요청자 · 시각 도우미
# ---------------------------------------------------------------------------


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(merchant.router)
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def _owner():
    profile = {
        "id": "00000000-0000-0000-0000-0000000000f1",
        "email": "owner@example.com",
        "is_anonymous": False,
        "role": "merchant",
        "facility_ids": frozenset({FAC}),
    }
    with patch.object(merchant, "load_profile_from_request", new=AsyncMock(return_value=profile)):
        yield


def _hours_ago(hours: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()


def _days_ago(days: float) -> str:
    return _hours_ago(days * 24)


def _kst_noon(days_back: int, *, plus_minutes: int = 0) -> str:
    """days_back 일 전 날짜(한국)의 정오. '같은 날' 판정이 테스트를 돌리는 시각에 흔들리지 않게 한다 —
    _hours_ago(2) 와 _hours_ago(2.1) 은 한국 자정 직후에 돌리면 서로 다른 날이 된다.
    days_back ≥ 1 이면 언제 돌려도 과거이고, 2 면 최근 7일, 9 면 직전 7일 안이다."""
    kst = timezone(timedelta(hours=9))
    day = (datetime.now(timezone.utc) - timedelta(days=days_back)).astimezone(kst).date()
    noon = datetime(day.year, day.month, day.day, 12, tzinfo=kst) + timedelta(minutes=plus_minutes)
    return noon.astimezone(timezone.utc).isoformat()


def _stats(client, db: _Db, **params):
    with patch.object(merchant, "supabase_admin", db), patch.object(authz, "supabase_admin", db):
        return client.get(
            "/api/v1/merchant/stats",
            params={"facility_id": FAC, **params},
            headers={"Authorization": "Bearer test-jwt"},
        )


_event_id = iter(range(1, 1_000_000))


def _card(at: str, *, anon: str = "anon-1", facility: str = FAC, rank=1, event: str = "rec_shown") -> dict:
    return {
        "id": next(_event_id),
        "created_at": at,
        "anon_id": anon,
        "event": event,
        "props": {"facility_id": facility, "type": "cafe", "rank": rank},
    }


INTERNAL_USERS = [
    {"id": ADMIN_ID, "role": "admin"},
    {"id": DEV_ID, "role": "developer"},
    {"id": "tourist-1", "role": "tourist"},
]


# ---------------------------------------------------------------------------
# 1. 노출 — 손님 화면에 그려진 카드
# ---------------------------------------------------------------------------


def test_exposures_count_rendered_cards_not_prefetched_list_rows(client):
    """미리 받은 추천 행이 아무리 많아도 노출은 화면에 그려진 카드 수다."""
    usage = [
        _card(_days_ago(30)),  # 기록 시작(직전 기간보다 앞) — 비교가 성립한다
        _card(_hours_ago(2), anon="anon-1"),
        _card(_hours_ago(5), anon="anon-1"),
        _card(_hours_ago(30), anon="anon-2"),
        _card(_hours_ago(3), anon="anon-3", rank=None),  # 검색·링크로 직접 연 카드 — 추천 노출이 아니다
        _card(_hours_ago(4), anon="anon-4", facility=OTHER),  # 다른 가게
        _card(_hours_ago(4), anon="anon-5", event="rec_accept"),  # 다른 이벤트
        _card(_days_ago(9), anon="anon-6"),  # 직전 7일
    ]
    # /main 프리페치가 남긴 목록 행 40개 — 예전에는 이것이 '노출' 이었다.
    prefetch = [
        {"id": f"r{i}", "user_id": f"t{i}", "recommended_facility_id": FAC, "source": "spot", "accepted": False,
         "created_at": _hours_ago(1 + i), "score_breakdown": {"travel_time": 5}}
        for i in range(40)
    ]
    res = _stats(client, _Db({"usage_events": usage, "recommendations": prefetch, "users": INTERNAL_USERS}))

    assert res.status_code == 200
    body = res.json()
    assert body["exposure_basis"] == "card_shown"
    assert body["recommendations_exposed"] == 3  # 예전 칸도 같은 숫자다(구 화면이 그대로 읽는다)
    exposures = body["metrics"]["exposures"]
    assert exposures["current"] == 3
    assert exposures["previous"] == 1
    assert exposures["people"] == 2  # 표본 — 익명 기기 수
    assert exposures["counted_since"] is None  # 이번 기간은 처음부터 기록이 있었다
    assert exposures["basis"] == "card_shown"


def test_card_tracking_start_inside_window_marks_partial_count_and_drops_comparison(client):
    """30일 창인데 카드 기록이 3일 전부터만 있다 — 언제부터인지 말하고, 직전 기간과 비교하지 않는다."""
    start = _days_ago(3)
    usage = [_card(start, facility=OTHER), _card(_hours_ago(10)), _card(_hours_ago(20))]
    res = _stats(client, _Db({"usage_events": usage}), days=30)

    body = res.json()
    exposures = body["metrics"]["exposures"]
    assert body["window_days"] == 30
    assert exposures["current"] == 2
    assert exposures["previous"] is None  # 0 이 아니다 — 비교할 수 없다
    assert exposures["counted_since"] is not None
    assert abs(datetime.fromisoformat(exposures["counted_since"]) - datetime.fromisoformat(start)) < timedelta(seconds=1)


def test_tracking_start_inside_previous_window_keeps_current_whole_but_drops_comparison(client):
    """기록이 10일 전부터면 최근 7일은 온전하지만 직전 7일(8~14일 전)은 일부뿐이다."""
    usage = [_card(_days_ago(10), facility=OTHER), _card(_days_ago(9)), _card(_hours_ago(6))]
    body = _stats(client, _Db({"usage_events": usage})).json()

    exposures = body["metrics"]["exposures"]
    assert exposures["current"] == 1
    assert exposures["counted_since"] is None
    assert exposures["previous"] is None


def test_exposures_fall_back_to_list_rows_with_a_different_basis(client):
    """카드 기록을 못 읽으면 목록 행으로 물러서되, 다른 숫자라는 것을 기준 칸으로 알린다."""
    rows = [
        # 목록에 들어간 행(by-type·메인 추천 — score_breakdown 에 travel_time 이 있다)
        {"id": "r1", "user_id": "t1", "recommended_facility_id": FAC, "source": "spot", "accepted": False,
         "created_at": _hours_ago(2), "score_breakdown": {"travel_time": 4}},
        # 새 수락: 노출된 그 행이 accepted=true 로 바뀐 것 — 목록 행으로서 한 번만 센다
        {"id": "r2", "user_id": "t2", "recommended_facility_id": FAC, "source": "spot", "accepted": True,
         "created_at": _hours_ago(3), "score_breakdown": {"travel_time": 6}},
        # 예전 수락 행(빈 score_breakdown) — 목록에 들어간 적이 없다
        {"id": "r3", "user_id": "t2", "recommended_facility_id": FAC, "source": "spot", "accepted": True,
         "created_at": _hours_ago(3), "score_breakdown": {}},
        # 메인 탐색의 '관심 없음'
        {"id": "r4", "user_id": "t3", "recommended_facility_id": FAC, "source": "browse", "accepted": False,
         "created_at": _hours_ago(4), "score_breakdown": {"travel_time": 3}},
        # 관리자 계정이 받은 추천
        {"id": "r5", "user_id": ADMIN_ID, "recommended_facility_id": FAC, "source": "spot", "accepted": False,
         "created_at": _hours_ago(5), "score_breakdown": {"travel_time": 3}},
        # 다른 가게
        {"id": "r6", "user_id": "t4", "recommended_facility_id": OTHER, "source": "spot", "accepted": False,
         "created_at": _hours_ago(5), "score_breakdown": {"travel_time": 3}},
        # 직전 7일
        {"id": "r7", "user_id": "t5", "recommended_facility_id": FAC, "source": "spot", "accepted": False,
         "created_at": _days_ago(10), "score_breakdown": {"travel_time": 3}},
    ]
    db = _Db({"recommendations": rows, "users": INTERNAL_USERS}, failing=frozenset({"usage_events"}))
    body = _stats(client, db).json()

    assert body["exposure_basis"] == "list_rows"
    exposures = body["metrics"]["exposures"]
    assert (exposures["current"], exposures["previous"], exposures["people"]) == (2, 1, 2)
    assert exposures["counted_since"] is None
    assert body["recommendations_exposed"] == 2


def test_empty_card_log_is_not_read_as_nobody_saw_the_store(client):
    """표는 있는데 카드 기록이 한 번도 없으면(기록이 꺼진 배포) 0 대신 목록 행 기준으로 물러선다."""
    rows = [{"id": "r1", "user_id": "t1", "recommended_facility_id": FAC, "source": "spot", "accepted": False,
             "created_at": _hours_ago(2), "score_breakdown": {"travel_time": 4}}]
    body = _stats(client, _Db({"usage_events": [], "recommendations": rows})).json()
    assert body["exposure_basis"] == "list_rows"
    assert body["recommendations_exposed"] == 1


def test_card_exposures_page_past_the_postgrest_row_cap(client):
    """1,000행에서 멈추지 않는다 — 예전 .limit(5000) 은 PostgREST 캡 아래에서 아무 일도 하지 않았다."""
    usage = [_card(_days_ago(20))] + [_card(_hours_ago(1 + i * 0.1), anon=f"a{i % 50}") for i in range(1_200)]
    body = _stats(client, _Db({"usage_events": usage})).json()
    assert body["metrics"]["exposures"]["current"] == 1_200
    assert body["metrics"]["exposures"]["people"] == 50


# ---------------------------------------------------------------------------
# 2. 길안내 시작 — 예전 수락 행 + 새 수락, 같은 손님·같은 날은 한 번
# ---------------------------------------------------------------------------


def test_accepts_count_legacy_and_updated_rows_once_per_guest_per_day(client):
    day = _kst_noon(2)
    rows = [
        # 손님 A — 예전 모양(새 행 삽입)을 두 번 눌렀다(같은 날) → 한 번
        {"id": "a1", "user_id": "guest-a", "recommended_facility_id": FAC, "source": "spot", "accepted": True,
         "created_at": day, "score_breakdown": {}},
        {"id": "a2", "user_id": "guest-a", "recommended_facility_id": FAC, "source": "spot", "accepted": True,
         "created_at": _kst_noon(2, plus_minutes=6), "score_breakdown": {}},
        # 손님 B — 새 모양(노출 행을 갱신) → 한 번
        {"id": "b1", "user_id": "guest-b", "recommended_facility_id": FAC, "source": "spot", "accepted": True,
         "created_at": day, "score_breakdown": {"travel_time": 5}},
        # 손님 C — 이행 중 한 수락이 갱신 + 삽입으로 두 번 적혔다 → 한 번
        {"id": "c1", "user_id": "guest-c", "recommended_facility_id": FAC, "source": "spot", "accepted": True,
         "created_at": day, "score_breakdown": {"travel_time": 5}},
        {"id": "c2", "user_id": "guest-c", "recommended_facility_id": FAC, "source": "spot", "accepted": True,
         "created_at": _kst_noon(2, plus_minutes=3), "score_breakdown": {}},
        # 노출만 되고 수락되지 않은 행
        {"id": "d1", "user_id": "guest-d", "recommended_facility_id": FAC, "source": "spot", "accepted": False,
         "created_at": day, "score_breakdown": {"travel_time": 5}},
        # 관리자·개발자 계정의 수락
        {"id": "e1", "user_id": ADMIN_ID, "recommended_facility_id": FAC, "source": "spot", "accepted": True,
         "created_at": day, "score_breakdown": {}},
        {"id": "e2", "user_id": DEV_ID, "recommended_facility_id": FAC, "source": "spot", "accepted": True,
         "created_at": day, "score_breakdown": {}},
        # 다른 가게
        {"id": "f1", "user_id": "guest-f", "recommended_facility_id": OTHER, "source": "spot", "accepted": True,
         "created_at": day, "score_breakdown": {}},
        # 손님 A 가 9일 전에도 왔다 → 직전 7일의 한 번
        {"id": "a3", "user_id": "guest-a", "recommended_facility_id": FAC, "source": "spot", "accepted": True,
         "created_at": _kst_noon(9), "score_breakdown": {}},
    ]
    body = _stats(client, _Db({"recommendations": rows, "users": INTERNAL_USERS})).json()

    accepts = body["metrics"]["accepts"]
    assert (accepts["current"], accepts["previous"], accepts["people"]) == (3, 1, 3)
    assert body["recommendations_accepted"] == 3


def test_same_guest_on_different_days_counts_each_day(client):
    rows = [
        {"id": "a1", "user_id": "guest-a", "recommended_facility_id": FAC, "source": "spot", "accepted": True,
         "created_at": _days_ago(1), "score_breakdown": {}},
        {"id": "a2", "user_id": "guest-a", "recommended_facility_id": FAC, "source": "spot", "accepted": True,
         "created_at": _days_ago(3), "score_breakdown": {}},
    ]
    accepts = _stats(client, _Db({"recommendations": rows})).json()["metrics"]["accepts"]
    assert (accepts["current"], accepts["people"]) == (2, 1)


# ---------------------------------------------------------------------------
# 3. 도착 확인 — recommendation_outcomes ⋈ recommendations
# ---------------------------------------------------------------------------


def _outcome(rec_id: str, user: str, arrived_at, *, facility: str = FAC, source: str = "spot") -> dict:
    return {
        "recommendation_id": rec_id,
        "user_id": user,
        "navigation_started_at": _days_ago(20),
        "arrival_confirmed_at": arrived_at,
        "recommendations": {"recommended_facility_id": facility, "source": source},
    }


def test_arrivals_come_from_confirmed_outcomes_of_this_store(client):
    outcomes = [
        _outcome("r1", "guest-a", _hours_ago(3)),
        _outcome("r2", "guest-b", _kst_noon(2)),
        _outcome("r3", "guest-b", _kst_noon(2, plus_minutes=30)),  # 같은 손님·같은 날 → 한 번
        _outcome("r4", "guest-c", None),  # 길안내만 시작하고 도착은 확인하지 않았다
        _outcome("r5", "guest-d", _hours_ago(3), facility=OTHER),  # 다른 가게
        _outcome("r6", ADMIN_ID, _hours_ago(3)),  # 관리자 계정
        _outcome("r7", "guest-e", _hours_ago(3), source="browse"),  # '관심 없음' 행
        _outcome("r8", "guest-f", _days_ago(10)),  # 직전 7일
    ]
    body = _stats(client, _Db({"recommendation_outcomes": outcomes, "users": INTERNAL_USERS})).json()

    arrivals = body["metrics"]["arrivals"]
    assert (arrivals["current"], arrivals["previous"], arrivals["people"]) == (2, 1, 2)
    # 예전 칸 — null(서버에 없다는 안내)이던 자리에 숫자가 들어간다.
    assert body["visit_confirmations"] == 2
    assert "도착" in body["visit_confirmations_note"]


def test_arrivals_unavailable_do_not_take_the_scorecard_down(client):
    """도착 기록만 못 읽으면 그 칸만 null — 나머지 숫자는 그대로 준다."""
    coupons = [{"id": "c1", "user_id": "guest-a", "facility_id": FAC, "status": "issued", "issued_at": _hours_ago(2)}]
    db = _Db({"user_coupons": coupons}, failing=frozenset({"recommendation_outcomes"}))
    res = _stats(client, db)

    assert res.status_code == 200
    body = res.json()
    assert body["visit_confirmations"] is None
    assert body["metrics"]["arrivals"] == {"current": None, "previous": None, "people": None, "counted_since": None}
    assert body["coupons_issued"] == 1


# ---------------------------------------------------------------------------
# 4. 쿠폰·제보 — 기간 분리 · 내부 계정 제외
# ---------------------------------------------------------------------------


def test_coupons_and_reports_split_by_period_without_internal_accounts(client):
    coupons = [
        {"id": "c1", "user_id": "guest-a", "facility_id": FAC, "status": "used", "issued_at": _hours_ago(5)},
        {"id": "c2", "user_id": "guest-b", "facility_id": FAC, "status": "issued", "issued_at": _days_ago(2)},
        {"id": "c3", "user_id": ADMIN_ID, "facility_id": FAC, "status": "used", "issued_at": _days_ago(1)},
        {"id": "c4", "user_id": "guest-c", "facility_id": FAC, "status": "used", "issued_at": _days_ago(8)},
        {"id": "c5", "user_id": "guest-d", "facility_id": OTHER, "status": "used", "issued_at": _days_ago(1)},
        {"id": "c6", "user_id": "guest-e", "facility_id": FAC, "status": "used", "issued_at": _days_ago(20)},
    ]
    reports = [
        {"id": "l1", "facility_id": FAC, "source": "user_report", "reporter_user_id": None, "timestamp": _hours_ago(1)},
        {"id": "l2", "facility_id": FAC, "source": "user_report", "reporter_user_id": DEV_ID, "timestamp": _hours_ago(1)},
        {"id": "l3", "facility_id": FAC, "source": "merchant_report", "reporter_user_id": "o", "timestamp": _hours_ago(1)},
        {"id": "l4", "facility_id": FAC, "source": "user_report", "reporter_user_id": "g", "timestamp": _days_ago(10)},
    ]
    db = _Db({"user_coupons": coupons, "congestion_logs": reports, "users": INTERNAL_USERS})
    body = _stats(client, db).json()

    metrics = body["metrics"]
    assert (metrics["coupons_issued"]["current"], metrics["coupons_issued"]["previous"]) == (2, 1)
    assert (metrics["coupons_used"]["current"], metrics["coupons_used"]["previous"]) == (1, 1)
    assert (metrics["congestion_reports"]["current"], metrics["congestion_reports"]["previous"]) == (1, 1)
    assert (body["coupons_issued"], body["coupons_used"], body["congestion_reports"]) == (2, 1, 1)
    assert body["internal_accounts_excluded"] is True


def test_internal_roles_are_rechecked_even_if_the_role_filter_is_missing(client):
    """users 조회에서 역할 필터가 빠진 응답이 와도 사장님(merchant)·관광객 기록을 지우지 않는다."""
    users = [{"id": "owner-1", "role": "merchant"}, {"id": "guest-a", "role": "tourist"}]

    class _NoRoleFilterDb(_Db):
        def table(self, name):
            query = super().table(name)
            if name == "users":
                query.in_ = lambda *_a, **_k: query  # 필터를 무시하는 응답
            return query

    coupons = [{"id": "c1", "user_id": "owner-1", "facility_id": FAC, "status": "issued", "issued_at": _hours_ago(1)}]
    body = _stats(client, _NoRoleFilterDb({"users": users, "user_coupons": coupons})).json()
    assert body["coupons_issued"] == 1


# ---------------------------------------------------------------------------
# 5. 기간 · 응답 봉투
# ---------------------------------------------------------------------------


def test_thirty_day_window_and_previous_period_bounds(client):
    coupons = [
        {"id": "c1", "user_id": "g1", "facility_id": FAC, "status": "issued", "issued_at": _days_ago(20)},
        {"id": "c2", "user_id": "g2", "facility_id": FAC, "status": "issued", "issued_at": _days_ago(45)},
        {"id": "c3", "user_id": "g3", "facility_id": FAC, "status": "issued", "issued_at": _days_ago(65)},
    ]
    body = _stats(client, _Db({"user_coupons": coupons}), days=30).json()

    assert body["window_days"] == 30
    since, previous_since, until = (datetime.fromisoformat(body[k]) for k in ("since", "previous_since", "until"))
    assert until - since == timedelta(days=30)
    assert since - previous_since == timedelta(days=30)
    assert (body["metrics"]["coupons_issued"]["current"], body["metrics"]["coupons_issued"]["previous"]) == (1, 1)


@pytest.mark.parametrize("days", ["14", "0", "abc"])
def test_only_seven_or_thirty_days(client, days):
    assert _stats(client, _Db({}), days=days).status_code == 422


def test_legacy_fields_keep_their_names_and_types(client):
    """구 화면(배포 순서가 어긋난 웹)이 읽는 칸은 이름·형이 그대로다."""
    body = _stats(client, _Db({})).json()
    for key in (
        "facility_id", "since", "window_days", "coupons_issued", "coupons_used", "congestion_reports",
        "recommendations_exposed", "recommendations_accepted", "visit_confirmations",
    ):
        assert key in body, key
    assert body["window_days"] == 7
    assert isinstance(body["visit_confirmations_note"], str)
    assert set(body["metrics"]) == {
        "exposures", "accepts", "arrivals", "coupons_issued", "coupons_used", "congestion_reports",
    }


def test_core_query_failure_is_still_500(client):
    """쿠폰처럼 예전부터 있던 숫자를 못 읽으면 예전처럼 실패다 — 빈 성적표를 '0' 으로 보이지 않는다."""
    res = _stats(client, _Db({}, failing=frozenset({"user_coupons"})))
    assert res.status_code == 500
