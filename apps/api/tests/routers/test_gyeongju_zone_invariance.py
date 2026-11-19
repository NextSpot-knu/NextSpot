"""경주 불변(서울 S3 — WP3 회귀 잠금): 헤더 없는 요청과 관광객 + 서울 헤더 요청은 **같은 경주 응답**이다.

네 엔진 경로(/recommendations · /recommendations/by-type · /courses/plan · /courses/recommend)마다:
  · 구역 표(zones · facility_zones · zone_crowd_snapshots)와 구역 RPC 호출 0회 — 경주는 구역 근거를 읽지 않는다.
  · 두 요청의 JSON 이 글자 하나 다르지 않다(헤더는 요청일 뿐이고 관광객은 경주다).
  · 응답 어디에도 'region' 키가 없다 — DB 행에는 region='gyeongju' 가 있어도 응답 사본에서 뺀다.
  · 채점 호출(calculate_spot_score)에 지역 인자가 실리지 않는다 — 경주 호출은 지역 도입 전과 같은 인자다.
"""

from __future__ import annotations

import pytest
from unittest.mock import patch

from app.routers import courses as courses_router
from app.routers import recommendations as reco_router
from app.services.crowd import zone_evidence
from tests.conftest import TOURIST_USER_ID, role_headers
from tests.routers.test_region_recommendations import (
    GJ_CENTER,
    GYEONGJU_IDS,
    REGION_HEADER,
    by_type_body,
    client,  # noqa: F401 — pytest 픽스처 재사용
    course_body,
    has_key_anywhere,
    make_db,
    reco_body,
    seoul_world,
)

ZONE_TABLES = ("zones", "facility_zones", "zone_crowd_snapshots")
REGION_SCORE_KWARGS = {"region", "evidence_now", "origin_zone_evidence"}


class _ZoneTablesExplode:
    def table(self, name):
        raise AssertionError(f"gyeongju request touched zone data: {name}")

    def rpc(self, name, _params):
        raise AssertionError(f"gyeongju request called rpc: {name}")


ENDPOINTS = {
    "recommendations": ("/api/v1/recommendations", lambda: reco_body(TOURIST_USER_ID, "g-attr", GJ_CENTER)),
    "by-type": ("/api/v1/recommendations/by-type", lambda: by_type_body(TOURIST_USER_ID, GJ_CENTER)),
    "courses/plan": ("/api/v1/courses/plan", lambda: course_body(TOURIST_USER_ID, GJ_CENTER)),
    "courses/recommend": ("/api/v1/courses/recommend", lambda: course_body(TOURIST_USER_ID, GJ_CENTER)),
}


def _facility_ids(name: str, body) -> set[str]:
    stops = body["stops"] if name == "courses/plan" else body
    return {item["facility"]["id"] for item in stops}


@pytest.mark.parametrize("name", list(ENDPOINTS))
def test_tourist_with_seoul_header_gets_the_same_gyeongju_response_with_zero_zone_calls(client, name):  # noqa: F811
    path, body = ENDPOINTS[name]
    db = make_db()
    score_kwargs: list[dict] = []
    real_reco_score = reco_router.calculate_spot_score
    real_course_score = courses_router.calculate_spot_score

    async def _spy_reco(**kwargs):
        score_kwargs.append(kwargs)
        return await real_reco_score(**kwargs)

    async def _spy_course(**kwargs):
        score_kwargs.append(kwargs)
        return await real_course_score(**kwargs)

    with seoul_world(db), \
         patch.object(zone_evidence, "supabase_admin", _ZoneTablesExplode()), \
         patch.object(reco_router, "calculate_spot_score", new=_spy_reco), \
         patch.object(courses_router, "calculate_spot_score", new=_spy_course):
        plain = client.post(path, json=body(), headers=role_headers("tourist"))
        with_header = client.post(path, json=body(), headers={**role_headers("tourist"), **REGION_HEADER})

    assert plain.status_code == 200, plain.text
    assert with_header.status_code == 200, with_header.text
    assert plain.json() == with_header.json()
    assert _facility_ids(name, plain.json()) and _facility_ids(name, plain.json()) <= GYEONGJU_IDS
    assert not has_key_anywhere(plain.json(), "region")
    for table in ZONE_TABLES:
        assert not db.queries_on(table), table
    assert not any(rpc_name == "zone_population_baseline" for rpc_name, _ in db.rpc_calls)
    assert score_kwargs and all(not (REGION_SCORE_KWARGS & set(kwargs)) for kwargs in score_kwargs)
    # 경주 풀은 경주로만 읽힌다(필터가 쿼리 안에 있다).
    pool_reads = [q for q in db.queries_on("facilities") if ("is_active", "eq", True) in q.filters]
    assert pool_reads and all(("region", "eq", "gyeongju") in q.filters for q in pool_reads)


def test_gyeongju_rows_keep_region_in_the_db_but_not_in_any_response(client):  # noqa: F811
    db = make_db()
    assert all(row["region"] for row in db.tables["facilities"])  # 마이그레이션 뒤의 행 — region 칸이 있다
    with seoul_world(db), patch.object(zone_evidence, "supabase_admin", _ZoneTablesExplode()):
        responses = [
            client.post(path, json=body(), headers=role_headers("tourist")).json()
            for path, body in ENDPOINTS.values()
        ]
    assert not any(has_key_anywhere(body, "region") for body in responses)
    # 응답에서 뺐다고 공유 캐시 행에서 지운 것이 아니다(test_region_engine_pipeline 이 캐시 쪽을 잠근다).
    assert all("region" in row for row in db.tables["facilities"])
