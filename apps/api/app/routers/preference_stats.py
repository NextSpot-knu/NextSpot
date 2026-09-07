"""온보딩 선호 집계 라우터 — 업종별 '이 업종을 선호로 고른 사용자 비율'.

왜 만들었나: 관리자 인프라 상세의 '예상 수요' 카드가 "온보딩 데이터 기반" 이라고 적어 놓고
실제로는 최신 congestion_logs 한 건을 등급으로 환산한 값만 보여줬다. 바로 위 '현재 상태' 와
**같은 숫자를 같은 라벨로 두 번** 그린 셈이다. 온보딩 선호(users.preferred_categories)를
실제로 계산에 넣으려면 업종별 선호 비율이 필요한데, 그 값을 주는 API 가 하나도 없었다.

수요 압력 = 지금 붐비는 정도(관측 혼잡) × 이 업종을 찾는 사람이 얼마나 많은가(선호 비율).
이 라우터는 뒤쪽 항만 책임진다 — 앞쪽 항은 화면이 이미 들고 있는 관측값이다.

정직성 계약:
  - **집계 비율만 내보낸다.** 사용자 id·닉네임·개별 선호 조합은 응답에 실리지 않는다.
  - 분모는 '전체 사용자' 가 아니라 **선호를 한 개 이상 고른 사용자 수**(= 온보딩 응답 표본)다.
    프로덕션 실측(2026-09-07)이 사용자 683명 중 26명만 선호를 갖고 있다 — 683 을 분모로
    쓰면 어떤 업종도 3% 를 넘지 못해 '아무도 찾지 않는 도시' 라는 없는 사실이 만들어진다.
  - 표본이 0명이면 shares 를 **빈 객체로** 돌려준다. 0.0 을 채워 보내면 화면이 그것을
    '선호 0%' 라는 관측 결과로 그릴 수 있다 — 모르는 것과 0 은 다른 사실이다.

성능:
  - users 는 PostgREST 단일 응답 캡(1000행)에 가까운 규모라(실측 683행) 전량 조회는
    fetch_all_rows 페이지네이션으로 한다. 지금 안 잘린다고 두면 유저가 늘어난 어느 날
    조용히 잘린 표본으로 비율을 계산하게 된다.
  - 온보딩 선호는 자주 바뀌는 값이 아니라서 프로세스 내 TTL 캐시를 둔다(events.py
    _detail_cache · predict.py _batch_cache 와 같은 모양: dict/tuple + time.monotonic).
    단일 인스턴스 데모 전제도 그 파일들과 같다.
"""
import asyncio
import time
from typing import Optional

import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.core.authz import ROLE_ADMIN, require_role
from app.core.supabase import fetch_all_rows, supabase_admin
from app.services.preference_nlp_service import VALID_CATEGORIES

logger = structlog.get_logger()
router = APIRouter(prefix="/api/v1/preference-stats", tags=["preference-stats"])

# 선호는 온보딩에서 한 번 정해지고 거의 바뀌지 않는다. 10분이면 관리자가 화면을 오가는 동안
# 같은 값을 보고, 그동안 users 전량 조회는 한 번만 돈다.
_CACHE_TTL_SECONDS = 600.0
_cache: Optional[tuple[float, "CategorySharesResponse"]] = None


class CategorySharesResponse(BaseModel):
    """업종별 선호 비율(0..1) + 그 비율이 선 근거.

    화면은 비율만이 아니라 sample_size 도 함께 보여 줘야 한다 — 26명의 73% 와 6,000명의 73%는
    같은 숫자지만 같은 근거가 아니다.
    """

    #: 선호를 한 개 이상 고른 사용자 수(= shares 의 분모). 0 이면 shares 는 비어 있다.
    sample_size: int
    #: 전체 사용자 수. 표본이 전체에서 얼마나 되는지 화면이 밝힐 수 있게 함께 준다.
    total_users: int
    #: 업종 코드(restaurant/cafe/attraction/culture) → 비율(0..1). 표본이 없으면 빈 객체.
    shares: dict[str, float]


def aggregate_category_shares(rows: list[dict]) -> CategorySharesResponse:
    """users 행들 → 업종별 선호 비율. DB·네트워크 없이 테스트 가능하도록 순수 함수로 뗀다.

    한 사용자가 같은 업종을 두 번 적어도 한 번만 센다(집합으로 좁힌다) — 비율의 분자는
    '고른 사람 수' 이지 '고른 횟수' 가 아니다. 화이트리스트 밖 값은 통째로 무시한다
    (선호 파서가 이미 enum 으로 좁히지만, DB 는 과거 값도 담고 있을 수 있다).
    """
    counts = {category: 0 for category in VALID_CATEGORIES}
    sample_size = 0
    for row in rows:
        raw = row.get("preferred_categories")
        if not isinstance(raw, list):
            continue
        picked = {c for c in raw if isinstance(c, str) and c in VALID_CATEGORIES}
        if not picked:
            continue
        sample_size += 1
        for category in picked:
            counts[category] += 1

    shares = (
        {category: round(counts[category] / sample_size, 4) for category in VALID_CATEGORIES}
        if sample_size
        else {}
    )
    return CategorySharesResponse(sample_size=sample_size, total_users=len(rows), shares=shares)


@router.get(
    "/categories",
    response_model=CategorySharesResponse,
    dependencies=[Depends(require_role(ROLE_ADMIN))],
)
async def category_preference_shares() -> CategorySharesResponse:
    """업종별 온보딩 선호 비율. 관리자 전용 — 개별 사용자 데이터는 응답에 없다."""
    global _cache
    now = time.monotonic()
    if _cache is not None and now - _cache[0] < _CACHE_TTL_SECONDS:
        return _cache[1]

    try:
        rows = await asyncio.to_thread(
            fetch_all_rows, supabase_admin, "users", "preferred_categories"
        )
    except Exception as e:
        # 실패를 '표본 0' 으로 흡수하지 않는다 — 그러면 화면이 카드를 조용히 숨기고,
        # 관리자는 선호를 고른 사람이 없다고 읽는다. 실패는 실패로 올린다.
        logger.error("preference_shares_query_failed", error=str(e))
        raise HTTPException(status_code=500, detail="선호 통계를 불러오지 못했습니다.")

    result = aggregate_category_shares(rows)
    _cache = (now, result)
    return result
