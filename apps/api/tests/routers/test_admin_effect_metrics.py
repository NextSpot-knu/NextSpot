# 관제 효과 지표의 정의(P1-1 · P0-5 f) — apps/api/app/routers/admin.py
#
# 잠그는 사실:
#   · '재배치' 는 수락 · 원본 ≠ 목적지 · 도착 확인만이다. 도착 미확인 수락·같은 장소 수락(메인 '바로 갈래요' 의
#     옛 모양 = 원본 = 목적지 새 행)·시설 정보 없음은 따로 센다 — 다른 에이전트가 바꾸는 새 모양(노출 행을 갱신)과
#     옛 모양이 한 창에 섞여도 같은 규칙으로 갈린다.
#   · 수락률은 수락 ÷ (수락 + 거절)이고 분자·분모가 같은 행 집합이다(메인 거절 = source 'browse' 포함).
#     예전에는 browse 거절을 분모에서 빼면서 수락은 셌다.
#   · 내부 계정(admin·developer)은 수락률·재배치·DAU 에서 빠진다.
#   · 표본 수(n)가 비율·합계와 늘 함께 실린다.
#   · 혼잡 '실측' 평균(30일 추이·오늘 집계)은 관리자 입력·모의·시드·주차 파생 추정을 세지 않는다.
#
# DB 는 test_routers.py 의 FakeSupabase(테이블별 canned 행 — 필터를 흡수한다)를 그대로 쓴다. 필터를 흡수하므로
# 여기서 통과한다는 것은 **파이썬 쪽 판정**이 정의를 지킨다는 뜻이다(쿼리 필터는 효율을 위한 겹이다).
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routers import admin
from tests.routers.test_routers import FakeSupabase, _admin_headers

NOW = datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat()


# 오늘(KST) 안에 확실히 드는 시각 — 응답 시각보다 조금 이전.
TODAY = _iso(max(NOW - timedelta(minutes=5), datetime.fromisoformat(admin._kst_today_range_utc()[0])))
YESTERDAY = _iso(datetime.fromisoformat(admin._kst_today_range_utc()[0]) - timedelta(hours=3))

USERS = [
    {"id": "u-admin", "role": "admin"},
    {"id": "u-dev", "role": "developer"},
    # 가짜는 role 필터를 흡수한다 — 관광객 행이 섞여 와도 내부 계정으로 세지 않아야 한다.
    {"id": "u1", "role": "tourist"},
]


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def _no_estimator_network(monkeypatch):
    """dashboard/today 의 추정(estimated)은 이 파일의 관심사가 아니다 — 원본 조회를 끊는다."""
    from app.services import congestion_estimator_service

    async def _isolated(_date_kst, **_kwargs):
        raise RuntimeError("estimator isolated in test")

    monkeypatch.setattr(congestion_estimator_service, "estimated_day_aggregate", _isolated)
    admin._estimate_inflight.clear()
    yield
    admin._estimate_inflight.clear()


def _db(**tables):
    return patch("app.routers.admin.supabase_admin", new=FakeSupabase({"users": USERS, **tables}))


# =========================================================================
# 1. /metrics — 수락률: 같은 모집단의 수락 ÷ (수락 + 거절), 내부 계정 제외, n 동반
# =========================================================================

_DECISION_ROWS = [
    # 수락 — 추천 화면 수락(새 모양: 노출 행 갱신)
    {"id": "r1", "user_id": "u1", "source": "spot", "accepted": True, "created_at": TODAY,
     "user_feedback": [{"action": "accepted_visit_intent"}]},
    # 수락 — 메인 '바로 갈래요' 옛 모양(원본 = 추천 새 행, 결정 행 없음)
    {"id": "r2", "user_id": "u2", "source": "spot", "accepted": True, "created_at": TODAY, "user_feedback": []},
    # 수락 — 결정 행은 수락인데 accepted 갱신이 실패한 행(결정이 이긴다)
    {"id": "r3", "user_id": "u3", "source": "spot", "accepted": False, "created_at": TODAY,
     "user_feedback": [{"action": "accepted_visit_intent"}]},
    # 거절 — 메인 거절(source 'browse') — 예전에는 분모에서 빠졌다
    {"id": "r4", "user_id": "u4", "source": "browse", "accepted": False, "created_at": TODAY,
     "user_feedback": [{"action": "rejected"}]},
    # 거절 — 추천 화면 거절
    {"id": "r5", "user_id": "u5", "source": "spot", "accepted": False, "created_at": TODAY,
     "user_feedback": [{"action": "rejected"}]},
    # 거절 — 임베드가 1:1 모양(dict)으로 와도 읽는다
    {"id": "r6", "user_id": "u6", "source": "spot", "accepted": False, "created_at": TODAY,
     "user_feedback": {"action": "rejected"}},
    # 결정 아님 — 노출만 / 건너뛰기 / 다른 대안 보기 / 만족도
    {"id": "r7", "user_id": "u7", "source": "spot", "accepted": False, "created_at": TODAY},
    {"id": "r8", "user_id": "u8", "source": "spot", "accepted": False, "created_at": TODAY,
     "user_feedback": [{"action": "skipped"}]},
    {"id": "r9", "user_id": "u9", "source": "spot", "accepted": False, "created_at": TODAY,
     "user_feedback": [{"action": "dismissed_batch"}, {"action": "helpful"}]},
    # 내부 계정 — 수락·거절 모두 빠진다
    {"id": "r10", "user_id": "u-admin", "source": "spot", "accepted": True, "created_at": TODAY},
    {"id": "r11", "user_id": "u-dev", "source": "browse", "accepted": False, "created_at": TODAY,
     "user_feedback": [{"action": "rejected"}]},
]


def test_metrics_acceptance_counts_accepts_and_rejects_on_one_population(client):
    with _db(recommendations=_DECISION_ROWS, user_feedback=[]):
        res = client.get("/api/v1/admin/metrics?days=8", headers=_admin_headers())

    assert res.status_code == 200
    acceptance = res.json()["acceptance"]
    assert acceptance["accepted"] == 3
    assert acceptance["rejected"] == 3
    assert acceptance["decisions"] == 6, "수락률의 표본 수(n)가 결정 수가 아니다"
    assert acceptance["rate"] == 0.5
    # 노출 행(browse 제외, 내부 계정 제외) — r1 r2 r3 r5 r6 r7 r8 r9
    assert acceptance["shown"] == 8
    assert acceptance["excluded_internal"] == 2
    assert acceptance["truncated"] is False


def test_metrics_acceptance_rate_is_null_without_decisions(client):
    rows = [{"id": "r1", "user_id": "u1", "source": "spot", "accepted": False, "created_at": TODAY}]
    with _db(recommendations=rows, user_feedback=[]):
        body = client.get("/api/v1/admin/metrics", headers=_admin_headers()).json()
    assert body["acceptance"]["decisions"] == 0
    assert body["acceptance"]["rate"] is None, "결정 0건에서 0% 를 지어냈다"


def test_metrics_legacy_rows_keep_their_meaning_without_internal_accounts(client):
    """구 번들용 recommendations 키는 뜻(browse 제외 추천 행)을 그대로 두고 내부 계정만 뺀다 —
    결정 판정용 칸(id·user_id·임베드)은 응답에 늘리지 않는다."""
    with _db(recommendations=_DECISION_ROWS, user_feedback=[]):
        body = client.get("/api/v1/admin/metrics", headers=_admin_headers()).json()
    legacy = body["recommendations"]
    assert len(legacy) == 8
    assert all(set(row) <= {"accepted", "created_at", "source"} for row in legacy), legacy
    assert all(row["source"] != "browse" for row in legacy)


def test_metrics_active_users_today_excludes_internal_accounts(client):
    feedback = [
        {"user_id": "u1", "timestamp": TODAY},
        {"user_id": "u1", "timestamp": TODAY},
        {"user_id": "u2", "timestamp": TODAY},
        {"user_id": "u-admin", "timestamp": TODAY},
        {"user_id": "u3", "timestamp": YESTERDAY},
    ]
    with _db(recommendations=[], user_feedback=feedback):
        body = client.get("/api/v1/admin/metrics?days=8", headers=_admin_headers()).json()
    active = body["active_users"]
    assert active["users"] == 2
    assert active["events"] == 3, "DAU 의 표본 수(행 수)가 오늘·내부 제외 기준이 아니다"
    assert active["excluded_internal"] == 1
    assert active["since"] == admin._kst_today_range_utc()[0]
    # 구 키 feedback 은 창 전체(어제 포함) — 내부 계정만 빠진다.
    assert {row["user_id"] for row in body["feedback"]} == {"u1", "u2", "u3"}


def test_metrics_since_param_is_validated(client):
    with _db(recommendations=[], user_feedback=[]):
        assert client.get("/api/v1/admin/metrics?since=not-a-date", headers=_admin_headers()).status_code == 422
        ok = client.get("/api/v1/admin/metrics?since=2026-07-09T00:00:00Z", headers=_admin_headers())
    assert ok.status_code == 200
    assert ok.json()["since"] == "2026-07-09T00:00:00+00:00"
    assert ok.json()["acceptance"]["since"] == "2026-07-09T00:00:00+00:00"


def test_metrics_fail_closed_when_internal_accounts_cannot_be_read(client):
    """내부 계정을 못 읽으면 걸러지지 않은 수치를 걸러진 척 내보내지 않는다 — 500(화면은 '갱신 중')."""
    with _db(recommendations=_DECISION_ROWS, user_feedback=[]), \
            patch.object(admin, "_fetch_internal_user_ids", side_effect=RuntimeError("users down")):
        res = client.get("/api/v1/admin/metrics", headers=_admin_headers())
    assert res.status_code == 500


# =========================================================================
# 2. /impact — 재배치 = 수락 · 원본 ≠ 목적지 · 도착 확인
# =========================================================================

_ACCEPTED = [
    # 재배치 3건 — 예상 대기 차이의 세 근거(대기 예측식 / 혼잡 차이 근사 / 산정 불가)
    {"id": "a1", "user_id": "u1", "accepted": True, "original_facility_id": "A", "recommended_facility_id": "B",
     "created_at": TODAY, "score_breakdown": {"original_wait_time": 20.0, "wait_time": 5.0}},      # 15.0분
    {"id": "a2", "user_id": "u2", "accepted": True, "original_facility_id": "A", "recommended_facility_id": "C",
     "created_at": TODAY, "score_breakdown": {"incentive_relief": 0.4, "wait_time": 3.0}},         # 0.4×15 = 6.0분
    {"id": "a3", "user_id": "u3", "accepted": True, "original_facility_id": "A", "recommended_facility_id": "D",
     "created_at": TODAY, "score_breakdown": {}},                                                   # 산정 불가
    # 도착 미확인 — 결과 행 없음 / 결과 행은 있으나 도착 시각 없음(길찾기만 시작)
    {"id": "a4", "user_id": "u4", "accepted": True, "original_facility_id": "A", "recommended_facility_id": "B",
     "created_at": TODAY, "score_breakdown": {"original_wait_time": 99.0, "wait_time": 1.0}},
    {"id": "a5", "user_id": "u5", "accepted": True, "original_facility_id": "A", "recommended_facility_id": "B",
     "created_at": TODAY, "score_breakdown": {"original_wait_time": 99.0, "wait_time": 1.0}},
    # 같은 장소 — 메인 '바로 갈래요' 옛 모양(원본 = 추천 새 행). 도착이 확인돼도 재배치가 아니다.
    {"id": "a6", "user_id": "u6", "accepted": True, "original_facility_id": "B", "recommended_facility_id": "B",
     "created_at": TODAY, "score_breakdown": {}},
    # 시설 정보 없음 — 원본 시설이 지워져 SET NULL 된 행
    {"id": "a7", "user_id": "u7", "accepted": True, "original_facility_id": None, "recommended_facility_id": "B",
     "created_at": TODAY, "score_breakdown": {"original_wait_time": 99.0, "wait_time": 1.0}},
    # 내부 계정 — 도착까지 확인돼도 빠진다
    {"id": "a8", "user_id": "u-admin", "accepted": True, "original_facility_id": "A", "recommended_facility_id": "B",
     "created_at": TODAY, "score_breakdown": {"original_wait_time": 99.0, "wait_time": 1.0}},
    # 미수락 — 쿼리가 거른다(가짜는 흡수하므로 파이썬이 한 번 더 거른다)
    {"id": "a9", "user_id": "u9", "accepted": False, "original_facility_id": "A", "recommended_facility_id": "B",
     "created_at": TODAY, "score_breakdown": {"original_wait_time": 99.0, "wait_time": 1.0}},
]
_OUTCOMES = [
    {"recommendation_id": rid, "arrival_confirmed_at": TODAY} for rid in ("a1", "a2", "a3", "a6", "a8", "a9")
] + [{"recommendation_id": "a5", "arrival_confirmed_at": None}]


def test_impact_counts_only_confirmed_moves_as_relocations(client):
    with _db(recommendations=_ACCEPTED, recommendation_outcomes=_OUTCOMES):
        res = client.get("/api/v1/admin/impact?since=2026-07-09T00:00:00Z", headers=_admin_headers())

    assert res.status_code == 200
    body = res.json()
    assert body["relocations"] == 3
    assert body["accepted_total"] == 7, "수락 표본 수(n)가 내부 계정·미수락을 빼고 세지 않았다"
    assert body["accepted_moves_unconfirmed"] == 2
    assert body["accepted_same_facility"] == 1
    assert body["accepted_missing_facility"] == 1
    assert body["excluded_internal"] == 1
    # 네 갈래의 합이 수락 표본 수다(어느 수락도 두 번 세거나 버리지 않는다).
    assert (
        body["relocations"] + body["accepted_moves_unconfirmed"]
        + body["accepted_same_facility"] + body["accepted_missing_facility"]
    ) == body["accepted_total"]


def test_impact_expected_wait_difference_sums_relocations_only(client):
    with _db(recommendations=_ACCEPTED, recommendation_outcomes=_OUTCOMES):
        body = client.get("/api/v1/admin/impact?since=2026-07-09T00:00:00Z", headers=_admin_headers()).json()
    # 재배치 a1(15.0) + a2(6.0) 만 — 도착 미확인·같은 장소·내부 계정의 큰 값(99−1)은 하나도 들어오지 않는다.
    assert body["expected_wait_diff_minutes"] == 21.0
    assert body["saved_wait_minutes"] == 21.0, "구 키가 새 정의와 다른 값을 말한다"
    assert body["expected_wait_diff_basis"] == {"wait_model": 1, "congestion_gap": 1, "unavailable": 1}
    # 구 키 measured/estimated 는 근거별 행 수 그대로(이름만 남았다).
    assert body["measured"] == 1
    assert body["estimated"] == 1


def test_impact_without_arrivals_reports_zero_relocations_not_accepts(client):
    """도착 확인이 없으면 재배치 0 — 예전처럼 수락 행 수를 '재배치' 로 말하지 않는다."""
    with _db(recommendations=_ACCEPTED, recommendation_outcomes=[]):
        body = client.get("/api/v1/admin/impact?since=2026-07-09T00:00:00Z", headers=_admin_headers()).json()
    assert body["relocations"] == 0
    assert body["saved_wait_minutes"] == 0
    assert body["accepted_total"] == 7
    assert body["accepted_moves_unconfirmed"] == 5


def test_impact_handles_both_accept_shapes_in_one_window(client):
    """/recommendations/accept 의 두 모양이 한 창에 섞인다 — 옛 모양(원본 = 추천 새 행)은 같은 장소,
    새 모양(노출된 추천 행 갱신)은 그 행의 원본 ≠ 목적지 · 도착 확인으로 재배치가 된다.
    같은 추천이 두 번 세이지 않는다(새 모양은 새 행을 만들지 않는다)."""
    rows = [
        {"id": "old", "user_id": "u1", "accepted": True, "original_facility_id": "B", "recommended_facility_id": "B",
         "created_at": TODAY, "score_breakdown": {}},
        {"id": "new", "user_id": "u2", "accepted": True, "original_facility_id": "A", "recommended_facility_id": "B",
         "created_at": TODAY, "score_breakdown": {"original_wait_time": 12.0, "wait_time": 4.0}},
        # 새 모양이 유형별 목록(원본 = 추천)에서 고른 행을 갱신한 경우 — 같은 장소다.
        {"id": "bytype", "user_id": "u3", "accepted": True, "original_facility_id": "C", "recommended_facility_id": "C",
         "created_at": TODAY, "score_breakdown": {}},
    ]
    outcomes = [{"recommendation_id": rid, "arrival_confirmed_at": TODAY} for rid in ("old", "new", "bytype")]
    with _db(recommendations=rows, recommendation_outcomes=outcomes):
        body = client.get("/api/v1/admin/impact?since=2026-07-09T00:00:00Z", headers=_admin_headers()).json()
    assert body["accepted_total"] == 3
    assert body["relocations"] == 1
    assert body["accepted_same_facility"] == 2
    assert body["expected_wait_diff_minutes"] == 8.0


def test_impact_invalid_since_is_422(client):
    with _db(recommendations=[], recommendation_outcomes=[]):
        assert client.get("/api/v1/admin/impact?since=nope", headers=_admin_headers()).status_code == 422


def test_decision_and_impact_helpers_are_pure():
    assert admin._decision_of({"accepted": True}) == "accepted"
    assert admin._decision_of({"accepted": False, "user_feedback": [{"action": "rejected"}]}) == "rejected"
    assert admin._decision_of({"accepted": True, "user_feedback": [{"action": "rejected"}]}) == "accepted"
    assert admin._decision_of({"accepted": False, "user_feedback": None}) is None
    assert admin._decision_of({"accepted": False, "user_feedback": [{"action": "unsaved"}]}) is None
    # 문자열 숫자·불리언은 예상 대기로 읽지 않는다(불리언은 float 로 변환되면 1.0 이 된다).
    summary = admin._impact_summary(
        [{"id": "x", "accepted": True, "original_facility_id": "A", "recommended_facility_id": "B",
          "score_breakdown": {"original_wait_time": True, "wait_time": 0.0, "incentive_relief": "0.2"}}],
        {"x"}, set(),
    )
    assert summary["basis"] == {"wait_model": 0, "congestion_gap": 1, "unavailable": 0}
    assert summary["wait_diff"] == 3.0


# =========================================================================
# 3. /metrics/trend — 관측만의 일평균 + 하루 결정 수
# =========================================================================

def test_trend_excludes_non_observation_sources_and_counts_decisions(client):
    logs = [
        {"congestion_level": 0.8, "timestamp": TODAY, "source": "user_report"},
        {"congestion_level": 0.6, "timestamp": TODAY, "source": "merchant_report"},
        # 관측이 아니다 — 평균·표본 수에 들어가면 안 된다.
        {"congestion_level": 1.0, "timestamp": TODAY, "source": "admin_override"},
        {"congestion_level": 0.99, "timestamp": TODAY, "source": "simulated"},
        {"congestion_level": 0.95, "timestamp": TODAY, "source": "seed"},
        {"congestion_level": 0.9, "timestamp": TODAY, "source": "parking_derived"},
    ]
    recs = [
        {"id": "t1", "user_id": "u1", "source": "spot", "accepted": True, "created_at": TODAY},
        {"id": "t2", "user_id": "u2", "source": "browse", "accepted": False, "created_at": TODAY,
         "user_feedback": [{"action": "rejected"}]},
        {"id": "t3", "user_id": "u3", "source": "spot", "accepted": False, "created_at": TODAY},
        {"id": "t4", "user_id": "u4", "source": "spot", "accepted": False, "created_at": TODAY,
         "user_feedback": [{"action": "rejected"}]},
        {"id": "t5", "user_id": "u-admin", "source": "spot", "accepted": True, "created_at": TODAY},
    ]
    with _db(congestion_logs=logs, recommendations=recs):
        res = client.get("/api/v1/admin/metrics/trend?days=7", headers=_admin_headers())

    assert res.status_code == 200
    body = res.json()
    assert body["congestion_basis"] == "observed"
    assert body["excluded_sources"] == ["admin_override", "parking_derived", "seed", "simulated"]
    today_kst = (NOW + timedelta(hours=9)).strftime("%Y-%m-%d")
    day = next(d for d in body["daily"] if d["date"] == today_kst)
    assert day["avg_congestion"] == 0.7
    assert day["samples"] == 2
    # 결정 기준 — 수락 1 · 거절 2(메인 거절 포함), 내부 계정 제외
    assert (day["decisions"], day["accepted"], day["rejected"]) == (3, 1, 2)
    # 구 키 — browse 제외 추천 행 수 · 그중 수락(내부 계정 제외)
    assert (day["rec_total"], day["rec_accepted"]) == (3, 1)


def test_trend_day_with_only_non_observation_logs_is_unobserved(client):
    logs = [{"congestion_level": 0.99, "timestamp": TODAY, "source": "simulated"} for _ in range(10)]
    with _db(congestion_logs=logs, recommendations=[]):
        body = client.get("/api/v1/admin/metrics/trend?days=3", headers=_admin_headers()).json()
    assert all(d["avg_congestion"] is None and d["samples"] == 0 for d in body["daily"]), \
        "모의 발생만 있던 날이 관측일로 세였다"


# =========================================================================
# 4. /dashboard/today — '실측' 집계는 관측만
# =========================================================================

def _today_logs(level: float, source: str, count: int) -> list[dict]:
    return [
        {"congestion_level": level, "current_count": 10, "timestamp": TODAY, "source": source,
         "facility": {"name": f"{source}-시설", "type": "attraction"}}
        for _ in range(count)
    ]


def test_dashboard_today_average_ignores_simulated_and_override_rows(client):
    logs = _today_logs(0.5, "user_report", 5) + _today_logs(0.99, "simulated", 3) + _today_logs(1.0, "admin_override", 2)
    with _db(congestion_logs=logs):
        body = client.get("/api/v1/admin/dashboard/today", headers=_admin_headers()).json()
    assert body["hasLogs"] is True
    assert body["sampleCount"] == 5
    assert body["avgCongestion"]["value"] == 0.5
    assert body["anomalyCount"] == 0, "모의·관리자 입력이 이상 혼잡으로 세였다"
    assert body["sourceComposition"] == {"user_report": 5}
    assert {cell["facility"] for cell in body["heatmap"]} == {"user_report-시설"}


def test_dashboard_today_with_only_simulated_rows_has_no_measured_day(client):
    logs = _today_logs(0.99, "simulated", 8) + _today_logs(0.4, "parking_derived", 6)
    with _db(congestion_logs=logs):
        body = client.get("/api/v1/admin/dashboard/today", headers=_admin_headers()).json()
    assert body["hasLogs"] is False
    assert body["sampleCount"] == 0
    # 마지막 '관측' 도 모의 행이 아니다 — 고를 관측일이 없으니 폴백도 없다.
    assert body["latestObservedAt"] is None
    assert body["fallback"] is None


def test_anomaly_level_is_one_constant_shared_with_safety():
    from app.routers import safety
    from app.services.congestion_estimator_service import ANOMALY_LEVEL

    assert safety.DEFAULT_ALERT_THRESHOLD == ANOMALY_LEVEL
    rows = [{"congestion_level": ANOMALY_LEVEL, "timestamp": TODAY, "source": "user_report",
             "facility": {"name": "x", "type": "cafe"}}] * 5
    assert admin._aggregate_congestion_day(rows, [])["anomalyCount"] == 5
