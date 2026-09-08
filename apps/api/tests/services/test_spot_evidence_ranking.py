"""근거 등급 정렬(b) + 업종 기준선(a) — '정직한 방송이 손해' 를 없앴는가.

이 파일의 존재 이유는 맨 아래 시나리오 테스트 하나다:
사장님 A 가 좌석을 '여유(0.15)' 로 방송하면 A 는 measured_rules 로 들어가 대기 4.875분이
시간비용에 붙는다. 로그도 주변 신호도 없는 옆 가게 B 는 degraded_rules 라 0 이다.
거리·취향이 같으면 **B 가 A 를 이겼다.** 콘솔이 권장하는 행동이 그 가게의 순위를 떨어뜨렸고,
사용자에게는 '무지' 가 '한산' 으로 팔렸다.
"""

import re
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from app.services.spot import industry_baseline
from app.services.spot.industry_baseline import (
    MIN_BASELINE_FACILITIES_PER_TYPE,
    MIN_BASELINE_LOGS_PER_TYPE,
    get_industry_baseline_congestion,
)
from app.services.spot.ranking import (
    EVIDENCE_TIER_BY_SCORING_MODE,
    WEAKEST_EVIDENCE_TIER,
    scoring_evidence_tier,
    spot_ranking_sort_key,
)
from app.services.spot.score import calculate_spot_score

REPO_ROOT = Path(__file__).resolve().parents[4]
API_ROOT = Path(__file__).resolve().parents[2]
UNIT_VECTOR = [1.0 / (8 ** 0.5)] * 8
# 12:00 KST 출발 — wait_time 의 점심 피크 배수(1.3)가 걸리는 구간. 위 4.875분이 그 값이다.
NOON_KST_DEPART = datetime(2026, 8, 20, 3, 0, tzinfo=timezone.utc)


# =========================================================================
# 1. 등급표
# =========================================================================

def test_evidence_tier_orders_measured_above_area_stats_above_degraded():
    assert scoring_evidence_tier("measured_rules") < scoring_evidence_tier("area_stats_rules")
    assert scoring_evidence_tier("area_stats_rules") < scoring_evidence_tier("degraded_rules")


def test_model_shares_the_measured_tier_because_both_pay_a_real_wait():
    # 이 둘만 시간비용에 실제 대기(분)를 넣는다 — 비용 축이 같아 점수를 그대로 비교해도 된다.
    # 등급을 갈라 measured 를 위에 두면 '만석' 을 방송한 가게가 모델이 한산하다고 본 가게를
    # 항상 이긴다. 지금 고치려는 왜곡을 방향만 바꿔 다시 만드는 셈이다.
    assert scoring_evidence_tier("model") == scoring_evidence_tier("measured_rules")


def test_unknown_scoring_mode_falls_to_the_weakest_tier():
    # 새 모드를 등급표에 등록하는 걸 잊었을 때, 조용히 1등으로 올라가는 쪽이 아니라
    # 조용히 맨 뒤로 가는 쪽이 안전하다.
    assert scoring_evidence_tier(None) == WEAKEST_EVIDENCE_TIER
    assert scoring_evidence_tier("brand_new_mode") == WEAKEST_EVIDENCE_TIER
    assert WEAKEST_EVIDENCE_TIER == max(EVIDENCE_TIER_BY_SCORING_MODE.values())


def test_sort_key_puts_evidence_first_and_keeps_the_old_tiebreakers():
    weak_but_high = spot_ranking_sort_key("degraded_rules", 0.99, 10.0, "b")
    strong_but_low = spot_ranking_sort_key("measured_rules", 0.10, 900.0, "a")
    assert strong_but_low < weak_but_high

    # 같은 등급 안에서는 종전과 동일하다: 점수 내림차순 → 거리 → id.
    same_tier = sorted([
        spot_ranking_sort_key("measured_rules", 0.5, 100.0, "z"),
        spot_ranking_sort_key("measured_rules", 0.9, 900.0, "y"),
        spot_ranking_sort_key("measured_rules", 0.5, 50.0, "x"),
    ])
    assert [key[3] for key in same_tier] == ["y", "x", "z"]


# =========================================================================
# 2. 세 정렬 지점이 같은 키를 쓰는가
# =========================================================================
# 추천(/recommendations, /recommendations/by-type)과 코스(/courses/plan 의 슬롯별 후보)가
# 각각 정렬한다. 한 곳만 빠뜨리면 같은 가게가 화면마다 다른 자리에 놓인다 — 그 사고는
# 동작 테스트로는 '그 화면을 안 봤으면' 안 잡히므로 소스 자체를 본다.

def test_every_spot_sort_goes_through_the_shared_ranking_key():
    sort_sites = []
    for name in ("recommendations.py", "courses.py"):
        source = (API_ROOT / "app" / "routers" / name).read_text(encoding="utf-8")
        # `.sort(` 뒤 한 문장(빈 줄 전까지, 최대 400자)만 본다 — 정렬을 어떻게 적든
        # 그 안에서 spot_score 를 읽으면 SPOT 정렬 지점이다.
        for chunk in source.split(".sort(")[1:]:
            statement = chunk[:400].split("\n\n")[0]
            if "spot_score" in statement:
                sort_sites.append((name, statement))

    assert len(sort_sites) == 3, (
        f"SPOT 정렬 지점이 3곳이 아니다({[name for name, _ in sort_sites]}) — "
        "새 정렬이 생겼다면 spot_ranking_sort_key 를 쓰게 하고 이 숫자를 고칠 것"
    )
    for name, body in sort_sites:
        assert "spot_ranking_sort_key" in body, f"{name} 의 SPOT 정렬이 공용 키를 쓰지 않는다"


# =========================================================================
# 3. 업종 기준선(a)
# =========================================================================

class _FakeQuery:
    """PostgREST 체인 흉내 — range() 로 페이지를 잘라 준다(1000행 캡 재현)."""

    def __init__(self, rows: list[dict], calls: dict):
        self._rows = rows
        self._calls = calls
        self._start = 0
        self._end = len(rows)

    def in_(self, column: str, values: list[str]):
        self._calls.setdefault("filters", []).append((column, tuple(sorted(values))))
        return self

    def range(self, start: int, end: int):
        self._start, self._end = start, end + 1
        return self

    def execute(self):
        self._calls["pages"] = self._calls.get("pages", 0) + 1
        return type("Res", (), {"data": self._rows[self._start:self._end]})()


class _FakeClient:
    def __init__(self, rows: list[dict], calls: dict):
        self._rows = rows
        self._calls = calls

    def table(self, name: str):
        self._calls["table"] = name
        return self

    def select(self, select: str):
        self._calls["select"] = select
        return _FakeQuery(self._rows, self._calls)


def _log(level: float, facility_id: str, facility_type: str) -> dict:
    return {
        "facility_id": facility_id,
        "congestion_level": level,
        "facilities": {"type": facility_type},
    }


@pytest.fixture
def baseline_reads(monkeypatch):
    """industry_baseline 을 가짜 Supabase 에 붙이고 캐시를 비운다."""
    calls: dict = {}

    def _bind(rows: list[dict]):
        industry_baseline.reset_cache()
        monkeypatch.setattr(industry_baseline, "supabase_admin", _FakeClient(rows, calls))
        return calls

    yield _bind
    industry_baseline.reset_cache()


@pytest.mark.asyncio
async def test_industry_baseline_reads_every_page_not_just_the_first_thousand(baseline_reads):
    # PostgREST 는 단일 응답을 1000행에서 조용히 자른다. 잘린 앞부분의 중앙값은
    # '전체 중앙값' 이 아니라 '삽입 순서 앞쪽의 중앙값' 이다.
    rows = (
        [_log(0.2, f"f-{i % 5}", "cafe") for i in range(1000)]
        + [_log(0.8, f"f-{i % 5}", "cafe") for i in range(1000)]
    )
    calls = baseline_reads(rows)

    baseline = await get_industry_baseline_congestion("cafe")

    assert calls["pages"] >= 3, "1000행 페이지네이션을 돌지 않았다(fetch_all_rows 미사용)"
    assert baseline == pytest.approx(0.5), "앞 1000행만 읽으면 0.2 가 나온다"
    # 점수에 영향을 줘도 되는 관측의 정의는 이 저장소에 이미 하나뿐이다.
    # (fetch_all_rows 는 페이지마다 같은 필터를 다시 건다 — 그래서 집합으로 본다.)
    assert set(calls["filters"]) == {("evidence_tier", ("corroborated", "verified"))}


@pytest.mark.asyncio
async def test_industry_baseline_is_withheld_when_the_sample_is_too_small(baseline_reads):
    # 관측 수 미달: 없는 값을 지어내지 않는다 — 등급만으로 처리한다.
    baseline_reads([_log(0.5, f"f-{i}", "cafe") for i in range(MIN_BASELINE_LOGS_PER_TYPE - 1)])
    assert await get_industry_baseline_congestion("cafe") is None


@pytest.mark.asyncio
async def test_industry_baseline_is_withheld_when_it_would_be_one_shops_diary(baseline_reads):
    # 관측은 충분하지만 가게가 모자란 경우. 부지런한 몇 곳의 일지를 업종 통계라고 부르지 않는다.
    rows = [
        _log(0.5, f"f-{i % (MIN_BASELINE_FACILITIES_PER_TYPE - 1)}", "cafe")
        for i in range(MIN_BASELINE_LOGS_PER_TYPE * 3)
    ]
    baseline_reads(rows)
    assert await get_industry_baseline_congestion("cafe") is None


@pytest.mark.asyncio
async def test_industry_baseline_failure_degrades_to_no_baseline(monkeypatch):
    # 상류 장애가 랭킹을 뒤집으면 안 된다. 실패는 '기준선 없음' 이고, 그게 이 기능의 기본값이다.
    industry_baseline.reset_cache()

    def _boom():
        raise RuntimeError("supabase down")

    monkeypatch.setattr(industry_baseline, "supabase_admin", property(lambda _self: _boom()))
    monkeypatch.setattr(
        industry_baseline, "fetch_all_rows",
        lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("supabase down")),
    )
    assert await get_industry_baseline_congestion("cafe") is None
    industry_baseline.reset_cache()


@pytest.mark.asyncio
async def test_industry_baseline_is_cached_across_candidates(baseline_reads):
    # 후보마다 전량 조회를 반복하면 안 된다(추천 1회에 후보 수십 곳).
    calls = baseline_reads([_log(0.5, f"f-{i % 5}", "cafe") for i in range(MIN_BASELINE_LOGS_PER_TYPE * 2)])
    for _ in range(5):
        assert await get_industry_baseline_congestion("cafe") == pytest.approx(0.5)
    assert calls["pages"] == 1, "TTL 캐시가 아니라 요청마다 조회하고 있다"


# =========================================================================
# 4. 기준선이 점수에 들어가는 방식
# =========================================================================

async def _score_degraded(facility: dict, baseline: float | None) -> object:
    async def _baseline(_facility_type):
        return baseline

    with patch("app.services.spot.score.calculate_preference_similarity", new=AsyncMock(return_value=0.8)), \
         patch("app.services.spot.score.predict_congestion_detailed", return_value=(None, "unavailable")), \
         patch("app.services.spot.score.get_model_info", return_value={"version": None}), \
         patch("app.services.spot.score.get_industry_baseline_congestion", new=_baseline):
        return await calculate_spot_score(
            user_id="u", preferred_categories=["restaurant"], original_congestion_level=None,
            candidate_facility=facility, user_lat=35.836, user_lng=129.21,
            user_vector=UNIT_VECTOR, depart_time=NOON_KST_DEPART,
            travel_time_override=5.0, travel_distance_override=330.0, travel_source="estimated",
        )


@pytest.mark.asyncio
async def test_industry_baseline_costs_time_without_claiming_a_measured_wait():
    facility = {"id": "b", "type": "restaurant", "latitude": 35.836, "longitude": 129.21, "features": {}}
    without = await _score_degraded(facility, None)
    with_baseline = await _score_degraded(facility, 0.4)

    assert with_baseline.breakdown["scoring_mode"] == "degraded_rules"
    assert with_baseline.score < without.score, "기준선이 시간비용에 반영되지 않았다"
    # 0.4 × 25분(식당 기본 처리시간) × 1.3(점심 피크) = 13.0분.
    assert with_baseline.breakdown["industry_baseline_wait_time"] == pytest.approx(13.0)
    assert with_baseline.breakdown["industry_baseline_congestion"] == pytest.approx(0.4)
    # 이 시설을 측정한 값이 아니다 — 대기 숫자를 파는 키로는 절대 새 나가면 안 된다.
    assert with_baseline.breakdown["wait_time"] is None
    assert with_baseline.breakdown["ranking_wait_time"] is None
    assert without.breakdown["industry_baseline_wait_time"] is None


@pytest.mark.asyncio
async def test_industry_baseline_separates_industries_inside_the_same_tier():
    # (b) 로 등급이 갈린 뒤에도 같은 degraded 등급 안에서는 전원이 대기 0분이라
    # 점심 식당과 카페가 같은 값으로 묶였다. 기준선은 그 안쪽을 가른다.
    async def _by_type(facility_type):
        return {"restaurant": 0.5, "cafe": 0.5}[facility_type]

    scores = {}
    for facility_type in ("restaurant", "cafe"):
        facility = {"id": facility_type, "type": facility_type, "latitude": 35.836, "longitude": 129.21, "features": {}}
        with patch("app.services.spot.score.calculate_preference_similarity", new=AsyncMock(return_value=0.8)), \
             patch("app.services.spot.score.predict_congestion_detailed", return_value=(None, "unavailable")), \
             patch("app.services.spot.score.get_model_info", return_value={"version": None}), \
             patch("app.services.spot.score.get_industry_baseline_congestion", new=_by_type):
            scores[facility_type] = await calculate_spot_score(
                user_id="u", preferred_categories=[], original_congestion_level=None,
                candidate_facility=facility, user_lat=35.836, user_lng=129.21,
                user_vector=UNIT_VECTOR, depart_time=NOON_KST_DEPART,
                travel_time_override=5.0, travel_distance_override=330.0, travel_source="estimated",
            )
    # 같은 중앙 혼잡도라도 회전이 느린 업종의 대기가 길다(식당 25분 vs 카페 12분).
    assert scores["cafe"].score > scores["restaurant"].score


# =========================================================================
# 5. 이 작업의 존재 이유 — 정직한 방송이 손해인가
# =========================================================================

@pytest.mark.asyncio
async def test_honest_seat_broadcast_no_longer_loses_to_a_candidate_with_no_evidence():
    """A(좌석 여유 0.15 방송) vs B(근거 없음). 거리·취향·쿠폰 동일."""
    now = NOON_KST_DEPART
    common = dict(
        user_id="u", preferred_categories=["restaurant"], original_congestion_level=None,
        user_lat=35.836, user_lng=129.21, user_vector=UNIT_VECTOR, depart_time=now,
        travel_time_override=5.0, travel_distance_override=330.0, travel_source="estimated",
    )
    facility_a = {"id": "a", "type": "restaurant", "latitude": 35.836, "longitude": 129.21, "features": {}}
    facility_b = {"id": "b", "type": "restaurant", "latitude": 35.836, "longitude": 129.21, "features": {}}

    async def _no_baseline(_facility_type):
        return None

    with patch("app.services.spot.score.calculate_preference_similarity", new=AsyncMock(return_value=0.8)), \
         patch("app.services.spot.score.predict_congestion_detailed", return_value=(None, "unavailable")), \
         patch("app.services.spot.score.get_model_info", return_value={"version": None}), \
         patch("app.services.spot.score.get_industry_baseline_congestion", new=_no_baseline):
        honest = await calculate_spot_score(
            **common, candidate_facility=facility_a,
            congestion_evidence={
                "source": "measured", "level": 0.15, "evidence_tier": "verified",
                "timestamp": now.isoformat(),
            },
        )
        silent = await calculate_spot_score(**common, candidate_facility=facility_b)

    # 전제가 실제로 성립하는지부터 확인한다 — 이게 깨지면 아래 결론은 아무것도 증명하지 않는다.
    assert honest.breakdown["scoring_mode"] == "measured_rules"
    assert silent.breakdown["scoring_mode"] == "degraded_rules"
    # 0.15 × 25분(식당 기본 처리시간) × 1.3(점심 피크) = 4.875 → 소수 1자리 반올림 4.9분이
    # A 의 시간비용에 붙는다. B 는 0 이다. 이 비대칭이 이 결함의 전부다.
    assert honest.breakdown["ranking_wait_time"] == pytest.approx(4.9)
    assert silent.breakdown["ranking_wait_time"] is None
    assert silent.score > honest.score, "픽스처 전제 붕괴: 점수만 보면 무근거가 이겨야 한다"

    # 옛 정렬(점수만)은 정직한 방송을 뒤로 보냈다.
    legacy_order = sorted(
        [("a", honest), ("b", silent)],
        key=lambda item: (-item[1].score, 330.0, item[0]),
    )
    assert [fid for fid, _ in legacy_order] == ["b", "a"], "옛 정렬의 결함을 재현하지 못했다"

    # 지금은 근거 등급이 먼저다 — 정직하게 방송한 A 가 앞선다.
    ranked = sorted(
        [("a", honest), ("b", silent)],
        key=lambda item: spot_ranking_sort_key(
            item[1].breakdown["scoring_mode"], item[1].score, 330.0, item[0],
        ),
    )
    assert [fid for fid, _ in ranked] == ["a", "b"], "정직한 방송이 여전히 손해다"


# =========================================================================
# 6. 프런트 미러 패리티
# =========================================================================

def test_evidence_tier_parity_with_web_mirror():
    """apps/web/lib/recommender.ts 가 같은 등급표를 쓰는가.

    백엔드만 2단계 정렬로 바꾸면 **같은 화면 안에서** 서버가 준 순위와 로컬 미러 순위가
    갈린다(main 화면은 두 목록을 한 배열로 합쳐 compareSpot 으로 정렬한다).
    """
    recommender = REPO_ROOT / "apps" / "web" / "lib" / "recommender.ts"
    if not recommender.exists():
        pytest.skip("apps/web/lib/recommender.ts 부재(모노레포 밖 실행) — 패리티 검증 생략")

    text = recommender.read_text(encoding="utf-8")
    block = re.search(
        r"export const EVIDENCE_TIER_BY_SCORING_MODE[^=]*=\s*\{(.*?)\};", text, re.DOTALL
    )
    assert block, "recommender.ts 에서 EVIDENCE_TIER_BY_SCORING_MODE 를 찾지 못했다"
    web_tiers = {
        name: int(value)
        for name, value in re.findall(r"(\w+):\s*(\d+)", block.group(1))
    }
    assert web_tiers == EVIDENCE_TIER_BY_SCORING_MODE

    weakest = re.search(r"export const WEAKEST_EVIDENCE_TIER = (\d+);", text)
    assert weakest, "recommender.ts 에서 WEAKEST_EVIDENCE_TIER 를 찾지 못했다"
    assert int(weakest.group(1)) == WEAKEST_EVIDENCE_TIER

    # 등급을 만들어 놓고 정렬이 안 쓰면 아무 일도 일어나지 않는다.
    assert re.search(r"if \(aTier !== bTier\) return aTier - bTier;", text), \
        "compareSpot 이 근거 등급을 먼저 보지 않는다"

    # 붐빔 컷오프도 같은 값이어야 한다. 한쪽만 있으면 같은 화면에서 서버가 뒤로 민 만석
    # 가게를 로컬 미러가 앞으로 끌어올린다.
    from app.services.spot.ranking import CROWDED_EVIDENCE_CUTOFF

    cutoff = re.search(r"export const CROWDED_EVIDENCE_CUTOFF = ([0-9.]+);", text)
    assert cutoff, "recommender.ts 에 CROWDED_EVIDENCE_CUTOFF 가 없다 — 미러가 붐빔 컷오프를 모른다"
    assert float(cutoff.group(1)) == pytest.approx(CROWDED_EVIDENCE_CUTOFF)

    # 컷오프를 상수로만 두고 비교에 안 넘기면 역시 아무 일도 일어나지 않는다.
    assert re.search(r"evidenceTier\(at\.scoringMode, at\.rankingCongestion\)", text), \
        "compareSpot 이 혼잡도를 등급 판정에 넘기지 않는다"


# =============================================================================
# 이미 붐비는 것이 확인된 후보는 등급 이점을 받지 않는다 (검토 38번 ii안)
# =============================================================================

def test_a_full_house_broadcast_no_longer_beats_every_unknown_candidate():
    """'만석' 을 방송해도 무근거 후보 전부를 이기지는 못한다.

    등급이 점수보다 앞서므로, 이 가드가 없으면 **어떤 값을 방송하든** 그 가게가 무근거
    가게 전부를 이긴다. 그러면 (1) 사장님 콘솔에 "아무 값이나 방송하면 이득" 이라는 유인이
    생기고, (2) 분산이라는 목표에서 '만석인 걸 아는 가게' 를 '모르는 가게' 위에 올리게 된다.
    앞의 왜곡('정직하면 손해')을 고치다 방향만 바꿔 새 왜곡을 만드는 셈이었다.
    """
    from app.services.spot.ranking import scoring_evidence_tier, spot_ranking_sort_key

    # (1) 등급 이점 자체가 사라진다 — 점수·거리가 같으면 두 후보는 같은 줄에 선다.
    crowded = spot_ranking_sort_key("measured_rules", 0.50, 100.0, "crowded", 0.95)
    unknown = spot_ranking_sort_key("degraded_rules", 0.50, 100.0, "unknown", None)
    assert crowded[0] == unknown[0], "만석 방송이 여전히 등급 이점을 갖는다"
    # 모드만 보면 이점이 있었다는 사실도 함께 남긴다(이 가드가 없으면 무엇이 바뀐 건지 흐려진다).
    assert scoring_evidence_tier("measured_rules") < scoring_evidence_tier("degraded_rules")

    # (2) 그래서 실제 상황에서 뒤집힌다. 만석이면 대기가 붙어 점수가 낮아지는데(0.30),
    #     예전에는 등급이 앞서 그 낮은 점수로도 무근거 후보(0.55)를 이겼다.
    crowded_real = spot_ranking_sort_key("measured_rules", 0.30, 100.0, "crowded", 0.95)
    unknown_real = spot_ranking_sort_key("degraded_rules", 0.55, 100.0, "unknown", None)
    assert crowded_real > unknown_real, "만석 방송이 낮은 점수로도 무근거 후보를 이긴다"


def test_an_honest_calm_broadcast_still_wins_over_no_evidence():
    """반대 방향은 그대로여야 한다 — '여유' 방송은 여전히 이긴다.

    이걸 함께 잠그지 않으면, 붐빔 컷오프를 넣다가 원래 고치려던 '정직한 방송이 손해' 를
    되살릴 수 있다.
    """
    from app.services.spot.ranking import spot_ranking_sort_key

    calm = spot_ranking_sort_key("measured_rules", 0.50, 400.0, "calm", 0.15)
    unknown = spot_ranking_sort_key("degraded_rules", 0.60, 300.0, "unknown", None)
    assert calm < unknown, "정직한 '여유' 방송이 무근거 후보에 밀린다"


def test_unknown_congestion_is_not_a_reason_to_demote():
    """혼잡도를 모른다는 이유로 강등하지 않는다. 강등은 '붐빔이 확인됐을 때' 만이다."""
    from app.services.spot.ranking import scoring_evidence_tier

    assert scoring_evidence_tier("measured_rules", None) == 0
    assert scoring_evidence_tier("measured_rules") == 0
    # 숫자가 아닌 값이 흘러들어도 모드 판정으로 안전하게 떨어진다.
    assert scoring_evidence_tier("measured_rules", "n/a") == 0  # type: ignore[arg-type]


def test_the_cutoff_reuses_the_dashboard_anomaly_line():
    """컷오프가 저장소의 기존 '이상 혼잡' 선과 같은 값인가.

    새 숫자를 만들면 "이 정도면 붐빔" 의 정의가 둘이 되고, 둘은 반드시 갈라진다.
    관리자 대시보드는 `congestion_level >= 0.9` 를 이상 혼잡으로 센다(admin.py).
    """
    from app.services.spot.ranking import CROWDED_EVIDENCE_CUTOFF

    admin_src = (Path(__file__).resolve().parents[2] / "app" / "routers" / "admin.py").read_text(
        encoding="utf-8"
    )
    assert re.search(r"congestion_level[^\n]{0,40}>=\s*0\.9", admin_src), (
        "admin.py 의 이상 혼잡 기준을 찾지 못했다 — 바뀌었다면 이 컷오프도 함께 봐야 한다"
    )
    assert CROWDED_EVIDENCE_CUTOFF == 0.9


def test_the_cutoff_is_inclusive_at_the_boundary():
    """경계값(정확히 0.9)도 '붐빔' 으로 본다 — 대시보드가 `>=` 로 세는 것과 같게."""
    from app.services.spot.ranking import WEAKEST_EVIDENCE_TIER, scoring_evidence_tier

    assert scoring_evidence_tier("measured_rules", 0.9) == WEAKEST_EVIDENCE_TIER
    assert scoring_evidence_tier("measured_rules", 0.899) == 0


def test_a_crowded_candidate_is_not_pushed_below_the_weakest_tier():
    """이점만 없앤다 — 이미 약한 등급을 더 내리지는 않는다.

    더 내리면 '붐빔이 확인된 곳' 이 '아무것도 모르는 곳' 보다 아래가 되는데, 그건 이번
    결정(ii안 = 등급 이점을 주지 않는다)의 범위를 넘는 별개의 정책이다.
    """
    from app.services.spot.ranking import WEAKEST_EVIDENCE_TIER, scoring_evidence_tier

    assert scoring_evidence_tier("degraded_rules", 0.99) == WEAKEST_EVIDENCE_TIER
    assert scoring_evidence_tier("area_stats_rules", 0.99) == WEAKEST_EVIDENCE_TIER
