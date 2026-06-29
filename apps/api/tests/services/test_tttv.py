import pytest
from unittest.mock import AsyncMock, patch

# 테스트 대상 모듈 임포트
from app.services.tttv.score import calculate_tttv_score
from app.services.tttv.wait_time import calculate_predicted_wait_time
from app.services.tttv.travel import calculate_haversine_distance, get_travel_time_and_distance
from app.services.tttv.preference import get_category_average_vector

@pytest.mark.asyncio
async def test_category_average_vector():
    # 1. 온보딩 선호 카테고리 벡터 생성 테스트 (관광 카테고리)
    pref_cats = ["restaurant", "cafe"]
    avg_vec = get_category_average_vector(pref_cats)

    # 8차원 벡터이고 L2 norm 크기가 1인지 검사
    assert len(avg_vec) == 8
    sq_sum = sum(x**2 for x in avg_vec)
    assert pytest.approx(sq_sum, 0.01) == 1.0


@pytest.mark.asyncio
async def test_calculate_predicted_wait_time():
    # 2. 예측 대기 시간 산출 공식 검증 (점심/오후 피크 보정 동작 검사)
    # 처리시간 20분 * 혼잡도 0.8 = 16분 (시간대 보정이 1.0일 경우)
    wait_time = await calculate_predicted_wait_time(
        facility_type="restaurant",
        congestion_level=0.8,
        facility_features={"average_processing_time": 20}
    )

    # 시간에 따라 1.0 또는 1.3 또는 1.2의 보정이 들어간 값이 나와야 함
    assert wait_time > 0
    assert wait_time in [16.0, 20.8, 19.2]  # 16 * 1.0, 16 * 1.3, 16 * 1.2


@pytest.mark.asyncio
async def test_haversine_distance():
    # 3. 직선 거리 연산 검증 (경주 황리단길 기준)
    # 동일 지점은 거리 0
    dist = calculate_haversine_distance(35.8360, 129.2100, 35.8360, 129.2100)
    assert dist == 0.0

    # 특정 인접 지점 간 거리 양수
    dist_diff = calculate_haversine_distance(35.8360, 129.2100, 35.8372, 129.2096)
    assert dist_diff > 0.0


@pytest.mark.asyncio
@patch("app.services.tttv.preference.preference_vector_service")
async def test_calculate_tttv_score(mock_pref):
    # 4. TTTV 종합 추천 점수 계산 테스트
    # 선호 벡터 저장소 조회 시 모의 8차원 정규 벡터 반환 모킹
    mock_pref.get_user_vector = AsyncMock(return_value=[1.0 / 3.0] * 8)

    candidate = {
        "id": "test-poi-1",
        "type": "restaurant",
        "latitude": 35.8372,
        "longitude": 129.2096,
        "capacity": 100,
        "features": {"average_processing_time": 15}
    }

    result = await calculate_tttv_score(
        user_id="test-user-id",
        preferred_categories=["restaurant"],
        original_facility_type="restaurant",
        original_congestion_level=0.9,
        candidate_facility=candidate,
        candidate_congestion_level=0.2,
        user_lat=35.8360,
        user_lng=129.2100
    )

    # 출력 구조 검증
    assert result.score >= 0.0 and result.score <= 1.0
    assert "preference" in result.breakdown
    assert "wait_time" in result.breakdown
    assert "travel_time" in result.breakdown
    assert "incentive" in result.breakdown

    # 원본이 0.9이고 대안이 0.2이므로 인센티브는 0.7이어야 함
    assert result.breakdown["incentive"] == 0.7
